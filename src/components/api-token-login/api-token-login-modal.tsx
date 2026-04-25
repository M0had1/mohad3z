import React, { useCallback, useState } from 'react';
import { generateDerivApiInstance } from '@/external/bot-skeleton/services/api/appId';
import { LegacyClose1pxIcon } from '@deriv/quill-icons/Legacy';
import { Localize, useTranslations } from '@deriv-com/translations';
import './api-token-login-modal.scss';

// ─── types ──────────────────────────────────────────────────────────────────

type TApiTokenLoginModalProps = {
    is_open: boolean;
    onClose: () => void;
};

type TLoginState = 'idle' | 'loading' | 'success' | 'error';

type TAuthorizeAccount = {
    loginid: string;
    token?: string;
    currency?: string;
    is_virtual?: number;
    landing_company_name?: string;
};

type TAuthorizeResult = {
    loginid: string;
    currency: string;
    balance: number;
    email: string;
    country: string;
    account_list: TAuthorizeAccount[];
};

type TAuthorizeResponse = {
    authorize?: TAuthorizeResult;
    error?: { message: string; code: string };
};

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Returns true for VRT / VRW (demo) login IDs */
const isDemo = (loginid: string) => /^(VRT|VRW)/i.test(loginid);

/**
 * Safely disconnect a DerivAPIBasic instance without throwing.
 * We type it as `any` to avoid importing the class (only available at build time).
 */
const safeDisconnect = (api: any) => {
    try { api?.disconnect?.(); } catch (_) { /* ignore */ }
};

/**
 * Wait for a DerivAPIBasic connection to be open (readyState === 1).
 * Resolves immediately if already open. Rejects after `timeoutMs`.
 */
const waitForOpen = (api: any, timeoutMs = 12000): Promise<void> =>
    new Promise((resolve, reject) => {
        if (api?.connection?.readyState === 1) { resolve(); return; }
        const t = setTimeout(() => reject(new Error('Connection timeout')), timeoutMs);
        api?.connection?.addEventListener('open', () => { clearTimeout(t); resolve(); });
        api?.connection?.addEventListener('error', () => {
            clearTimeout(t);
            reject(new Error('WebSocket connection failed'));
        });
    });

/**
 * Authorise `token` using the given server URL.
 *
 * We temporarily pin `config.server_url` in localStorage before calling
 * `generateDerivApiInstance()` so that `getSocketURL()` (inside appId.js)
 * connects to the right server. We restore the previous value (or remove it)
 * after the socket is created.
 */
const authorizeOnServer = async (token: string, serverUrl: string): Promise<TAuthorizeResponse> => {
    // Save & override server URL
    const prev = localStorage.getItem('config.server_url');
    localStorage.setItem('config.server_url', serverUrl);

    let api: any = null;
    try {
        api = generateDerivApiInstance();
        await waitForOpen(api);
        const result = await api.authorize(token) as TAuthorizeResponse;
        return result;
    } finally {
        // Always restore the previous server URL
        if (prev === null) {
            localStorage.removeItem('config.server_url');
        } else {
            localStorage.setItem('config.server_url', prev);
        }
        safeDisconnect(api);
    }
};

// ─── component ───────────────────────────────────────────────────────────────

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

        try {
            // ── Phase 1: probe on blue (neutral server) to get loginid ──────────
            // blue.derivws.com accepts any valid token and returns the loginid
            // without caring whether the account is real or demo.
            const phase1 = await authorizeOnServer(trimmed, 'blue.derivws.com');

            if (phase1.error || !phase1.authorize) {
                const e = phase1.error;
                let msg = localize('Authentication failed. Please check your token and try again.');
                if (e?.code === 'InvalidToken') {
                    msg = localize('Invalid API token. Please make sure you copied it correctly.');
                } else if (e?.code === 'DisabledClient') {
                    msg = localize('This account has been disabled. Please contact support.');
                } else if (e?.message) {
                    msg = e.message;
                }
                setErrorMessage(msg);
                setState('error');
                return;
            }

            const { loginid, currency, country, account_list } = phase1.authorize;
            const targetServer = isDemo(loginid) ? 'blue.derivws.com' : 'green.derivws.com';

            // ── Phase 2: re-authorize on the correct server ──────────────────────
            // Real accounts must connect to green.derivws.com — that's where
            // actual balances and trade execution live. This is exactly what
            // getDefaultServerURL() in config.ts does after a normal OAuth login.
            const phase2 = await authorizeOnServer(trimmed, targetServer);

            if (phase2.error || !phase2.authorize) {
                const e = phase2.error;
                let msg = localize('Authentication failed. Please try again.');
                if (e?.message) msg = e.message;
                setErrorMessage(msg);
                setState('error');
                return;
            }

            // ── Build localStorage — mirrors AuthWrapper.setLocalStorageToken ────
            const accountsList: Record<string, string> = {};
            const clientAccounts: Record<string, { loginid: string; token: string; currency: string }> = {};

            // Primary account — always mapped to the supplied token
            accountsList[loginid] = trimmed;
            clientAccounts[loginid] = { loginid, token: trimmed, currency: currency ?? 'USD' };

            // Additional accounts (carry their own tokens in account_list)
            if (Array.isArray(account_list)) {
                account_list.forEach(acc => {
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

            // Write all keys — same ones read by V2GetActiveToken, V2GetActiveClientId,
            // getDefaultServerURL, and CoreStoreProvider on app boot
            localStorage.setItem('accountsList',   JSON.stringify(accountsList));
            localStorage.setItem('clientAccounts', JSON.stringify(clientAccounts));
            localStorage.setItem('authToken',      trimmed);
            localStorage.setItem('active_loginid', loginid);
            // Pin the server so getSocketURL() uses it immediately on reload
            localStorage.setItem('config.server_url', targetServer);
            if (country) localStorage.setItem('client.country', country);

            setState('success');

            // Reload — AuthWrapper picks up localStorage and runs the full auth flow
            setTimeout(() => window.location.reload(), 800);

        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('timeout') || msg.includes('Connection') || msg.includes('WebSocket')) {
                setErrorMessage(
                    localize('Could not connect to Deriv servers. Please check your internet connection.')
                );
            } else {
                setErrorMessage(localize('An unexpected error occurred. Please try again.'));
            }
            setState('error');
        }
    }, [token, localize]);

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter' && state !== 'loading') handleLogin();
        },
        [handleLogin, state]
    );

    if (!is_open) return null;

    return (
        <div className='api-token-modal__overlay' onClick={handleClose} role='dialog' aria-modal='true'>
            <div className='api-token-modal__container' onClick={e => e.stopPropagation()} role='document'>

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
                        <Localize i18n_default_text='Enter your Deriv API token to log in directly. Make sure your token has Read and Trade permissions enabled.' />
                    </p>

                    <div className='api-token-modal__field'>
                        <label className='api-token-modal__label' htmlFor='api-token-input'>
                            <Localize i18n_default_text='API Token' />
                        </label>
                        <input
                            id='api-token-input'
                            className={`api-token-modal__input${error_message ? ' api-token-modal__input--error' : ''}`}
                            type='password'
                            value={token}
                            onChange={e => {
                                setToken(e.target.value);
                                if (state === 'error') { setState('idle'); setErrorMessage(''); }
                            }}
                            onKeyDown={handleKeyDown}
                            placeholder={localize('Paste your API token here')}
                            disabled={state === 'loading' || state === 'success'}
                            autoComplete='off'
                            // eslint-disable-next-line jsx-a11y/no-autofocus
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
                        <Localize i18n_default_text="Don't have an API token? " />
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
                        className={`api-token-modal__btn api-token-modal__btn--primary${state === 'loading' ? ' api-token-modal__btn--loading' : ''}`}
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
