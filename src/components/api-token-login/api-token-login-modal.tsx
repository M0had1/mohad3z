import React, { useCallback, useState } from 'react';
import { getAppId } from '@/components/shared';
import { getInitialLanguage } from '@deriv-com/translations';
import DerivAPIBasic from '@deriv/deriv-api/dist/DerivAPIBasic';
import { LegacyClose1pxIcon } from '@deriv/quill-icons/Legacy';
import { Localize, useTranslations } from '@deriv-com/translations';
import './api-token-login-modal.scss';

// ─── helpers ────────────────────────────────────────────────────────────────

/** Is this loginid a demo/virtual account? */
const isDemoLoginid = (loginid: string) => /^(VRT|VRW)/i.test(loginid);

/**
 * Open a DerivAPIBasic socket to a specific server and wait for it to be ready.
 * Returns the api instance. Rejects on timeout or socket error.
 */
const openSocket = (server: string): Promise<InstanceType<typeof DerivAPIBasic>> => {
    return new Promise((resolve, reject) => {
        const appId = getAppId();
        const lang = getInitialLanguage();
        const url = `wss://${server}/websockets/v3?app_id=${appId}&l=${lang}&brand=deriv`;
        const ws = new WebSocket(url);
        const api = new DerivAPIBasic({ connection: ws });
        const timeout = setTimeout(() => {
            try { ws.close(); } catch (_) { /* ignore */ }
            reject(new Error('Connection timeout'));
        }, 12000);
        ws.addEventListener('open', () => {
            clearTimeout(timeout);
            resolve(api);
        });
        ws.addEventListener('error', () => {
            clearTimeout(timeout);
            reject(new Error('WebSocket connection failed'));
        });
    });
};

/** Safely disconnect an api instance without throwing. */
const safeDisconnect = (api: InstanceType<typeof DerivAPIBasic> | null) => {
    try { (api as any)?.disconnect?.(); } catch (_) { /* ignore */ }
};

type TApiTokenLoginModalProps = {
    is_open: boolean;
    onClose: () => void;
};

type TLoginState = 'idle' | 'loading' | 'success' | 'error';

const ApiTokenLoginModal = ({ is_open, onClose }: TApiTokenLoginModalProps) => {
    const [token, setToken] = useState('');
    const [state, setState] = useState<TLoginState>('idle');
    const [error_message, setErrorMessage] = useState('');
    const { localize } = useTranslations();

    const resetState = useCallback(() => {
        setToken('');
        setState('idle');
        setErrorMessage('');
    }, []);

    const handleClose = useCallback(() => {
        resetState();
        onClose();
    }, [onClose, resetState]);

    const handleLogin = useCallback(async () => {
        const trimmed = token.trim();
        if (!trimmed) {
            setErrorMessage(localize('Please enter your API token.'));
            setState('error');
            return;
        }

        setState('loading');
        setErrorMessage('');

        // Phase-1 api (blue/demo server — safe neutral entry point)
        let api1: InstanceType<typeof DerivAPIBasic> | null = null;
        // Phase-2 api (correct server once we know real vs demo)
        let api2: InstanceType<typeof DerivAPIBasic> | null = null;

        type AuthorizeAccount = {
            loginid: string;
            token?: string;
            currency?: string;
            is_virtual?: number;
            landing_company_name?: string;
        };

        type AuthorizeResponse = {
            authorize: {
                loginid: string;
                currency: string;
                balance: number;
                email: string;
                country: string;
                account_list: AuthorizeAccount[];
            };
            error?: { message: string; code: string };
        };

        try {
            // ── Phase 1: connect to blue (neutral) to discover the loginid ───────
            // blue.derivws.com serves both real and demo accounts for auth purposes.
            // We need the loginid first to know which server to use for the app.
            api1 = await openSocket('blue.derivws.com');

            const phase1 = (await (api1 as any).authorize(trimmed)) as AuthorizeResponse;

            if (phase1.error) {
                const e = phase1.error;
                let msg = localize('Authentication failed. Please check your token and try again.');
                if (e.code === 'InvalidToken') msg = localize('Invalid API token. Please make sure you copied it correctly.');
                else if (e.code === 'DisabledClient') msg = localize('This account has been disabled. Please contact support.');
                else if (e.message) msg = e.message;
                setErrorMessage(msg);
                setState('error');
                safeDisconnect(api1);
                return;
            }

            const { loginid, currency, country, account_list } = phase1.authorize;
            const isDemo = isDemoLoginid(loginid);

            // ── Phase 2: open the CORRECT server socket ───────────────────────────
            // Real accounts must use green.derivws.com — this is what the app
            // uses after login and what balance subscriptions run against.
            // Demo accounts use blue.derivws.com.
            // getDefaultServerURL() in config.ts does the same check.
            safeDisconnect(api1);
            api1 = null;

            const targetServer = isDemo ? 'blue.derivws.com' : 'green.derivws.com';
            api2 = await openSocket(targetServer);

            const phase2 = (await (api2 as any).authorize(trimmed)) as AuthorizeResponse;

            if (phase2.error) {
                const e = phase2.error;
                let msg = localize('Authentication failed. Please try again.');
                if (e.message) msg = e.message;
                setErrorMessage(msg);
                setState('error');
                safeDisconnect(api2);
                return;
            }

            // ── Build localStorage structures ──────────────────────────────────
            // Must exactly mirror what AuthWrapper.setLocalStorageToken() writes
            // so that api-base.ts → authorizeAndSubscribe() picks everything up.
            const accountsList: Record<string, string> = {};
            const clientAccounts: Record<string, { loginid: string; token: string; currency: string }> = {};

            // Primary account — always use the provided token
            accountsList[loginid] = trimmed;
            clientAccounts[loginid] = { loginid, token: trimmed, currency: currency ?? 'USD' };

            // All additional accounts from account_list (each carries its own token)
            if (Array.isArray(account_list)) {
                account_list.forEach((acc: AuthorizeAccount) => {
                    if (acc.loginid && acc.loginid !== loginid && acc.token) {
                        accountsList[acc.loginid] = acc.token;
                        clientAccounts[acc.loginid] = {
                            loginid: acc.loginid,
                            token: acc.token,
                            currency: acc.currency ?? 'USD',
                        };
                    }
                });
            }

            // Persist — same keys read by V2GetActiveToken, V2GetActiveClientId,
            // getDefaultServerURL, and CoreStoreProvider
            localStorage.setItem('accountsList', JSON.stringify(accountsList));
            localStorage.setItem('clientAccounts', JSON.stringify(clientAccounts));
            localStorage.setItem('authToken', trimmed);
            localStorage.setItem('active_loginid', loginid);
            if (country) localStorage.setItem('client.country', country);

            // Force the server URL so getSocketURL() returns the right server
            // immediately on reload (before active_loginid is re-read)
            localStorage.setItem('config.server_url', targetServer);

            safeDisconnect(api2);
            api2 = null;

            setState('success');

            // Reload — AuthWrapper reads localStorage and runs full auth flow
            setTimeout(() => window.location.reload(), 800);

        } catch (err: unknown) {
            safeDisconnect(api1);
            safeDisconnect(api2);
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('timeout') || msg.includes('Connection') || msg.includes('WebSocket')) {
                setErrorMessage(localize('Could not connect to Deriv servers. Please check your internet connection.'));
            } else {
                setErrorMessage(localize('An unexpected error occurred. Please try again.'));
            }
            setState('error');
        }
    }, [token, localize]);

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter' && state !== 'loading') {
                handleLogin();
            }
        },
        [handleLogin, state]
    );

    if (!is_open) return null;

    return (
        <div className='api-token-modal__overlay' onClick={handleClose} role='dialog' aria-modal='true'>
            <div
                className='api-token-modal__container'
                onClick={e => e.stopPropagation()}
                role='document'
            >
                {/* Header */}
                <div className='api-token-modal__header'>
                    <h2 className='api-token-modal__title'>
                        <Localize i18n_default_text='Log in with API token' />
                    </h2>
                    <button
                        className='api-token-modal__close-btn'
                        onClick={handleClose}
                        aria-label={localize('Close')}
                        type='button'
                    >
                        <LegacyClose1pxIcon iconSize='xs' />
                    </button>
                </div>

                {/* Body */}
                <div className='api-token-modal__body'>
                    <p className='api-token-modal__description'>
                        <Localize i18n_default_text='Enter your Deriv API token to log in directly. Make sure your token has the Read and Trade permissions enabled.' />
                    </p>

                    <div className='api-token-modal__field'>
                        <label className='api-token-modal__label' htmlFor='api-token-input'>
                            <Localize i18n_default_text='API Token' />
                        </label>
                        <input
                            id='api-token-input'
                            className={`api-token-modal__input ${error_message ? 'api-token-modal__input--error' : ''}`}
                            type='password'
                            value={token}
                            onChange={e => {
                                setToken(e.target.value);
                                if (state === 'error') {
                                    setState('idle');
                                    setErrorMessage('');
                                }
                            }}
                            onKeyDown={handleKeyDown}
                            placeholder={localize('Paste your API token here')}
                            disabled={state === 'loading' || state === 'success'}
                            autoComplete='off'
                            autoFocus
                        />
                        {error_message && (
                            <span className='api-token-modal__error-msg' role='alert'>
                                {error_message}
                            </span>
                        )}
                    </div>

                    {state === 'success' && (
                        <div className='api-token-modal__success-msg' role='status'>
                            <Localize i18n_default_text='✓ Login successful! Redirecting...' />
                        </div>
                    )}

                    <div className='api-token-modal__help'>
                        <Localize
                            i18n_default_text="Don't have an API token? "
                        />
                        <a
                            href='https://app.deriv.com/account/api-token'
                            target='_blank'
                            rel='noopener noreferrer'
                            className='api-token-modal__link'
                        >
                            <Localize i18n_default_text='Create one here' />
                        </a>
                    </div>
                </div>

                {/* Footer */}
                <div className='api-token-modal__footer'>
                    <button
                        className='api-token-modal__btn api-token-modal__btn--secondary'
                        onClick={handleClose}
                        type='button'
                        disabled={state === 'loading' || state === 'success'}
                    >
                        <Localize i18n_default_text='Cancel' />
                    </button>
                    <button
                        className={`api-token-modal__btn api-token-modal__btn--primary ${state === 'loading' ? 'api-token-modal__btn--loading' : ''}`}
                        onClick={handleLogin}
                        type='button'
                        disabled={state === 'loading' || state === 'success' || !token.trim()}
                    >
                        {state === 'loading' ? (
                            <>
                                <span className='api-token-modal__spinner' />
                                <Localize i18n_default_text='Verifying...' />
                            </>
                        ) : (
                            <Localize i18n_default_text='Log in' />
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ApiTokenLoginModal;
