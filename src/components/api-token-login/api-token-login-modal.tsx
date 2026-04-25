import React, { useCallback, useState } from 'react';
import { generateDerivApiInstance } from '@/external/bot-skeleton/services/api/appId';
import { LegacyClose1pxIcon } from '@deriv/quill-icons/Legacy';
import { Localize, useTranslations } from '@deriv-com/translations';
import './api-token-login-modal.scss';

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

        let api: ReturnType<typeof generateDerivApiInstance> | null = null;

        try {
            api = generateDerivApiInstance();

            // Wait for WebSocket to open
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);
                if ((api as any)?.connection?.readyState === 1) {
                    clearTimeout(timeout);
                    resolve();
                } else {
                    (api as any)?.connection?.addEventListener('open', () => {
                        clearTimeout(timeout);
                        resolve();
                    });
                    (api as any)?.connection?.addEventListener('error', () => {
                        clearTimeout(timeout);
                        reject(new Error('WebSocket connection failed'));
                    });
                }
            });

            const { authorize, error } = (await (api as any).authorize(trimmed)) as {
                authorize: {
                    loginid: string;
                    token: string;
                    currency: string;
                    balance: number;
                    email: string;
                    account_list: Array<{ loginid: string; token: string; currency: string; is_virtual: number }>;
                };
                error?: { message: string; code: string };
            };

            if (error) {
                let friendly_error = localize('Authentication failed. Please check your token and try again.');
                if (error.code === 'InvalidToken') {
                    friendly_error = localize('Invalid API token. Please make sure you copied it correctly.');
                } else if (error.code === 'DisabledClient') {
                    friendly_error = localize('This account has been disabled. Please contact support.');
                } else if (error.message) {
                    friendly_error = error.message;
                }
                setErrorMessage(friendly_error);
                setState('error');
                return;
            }

            // Build account structures exactly as OAuth flow does
            const accountsList: Record<string, string> = {};
            const clientAccounts: Record<string, { loginid: string; token: string; currency: string }> = {};

            // Primary account from authorize response
            const loginid = authorize.loginid;
            accountsList[loginid] = trimmed;
            clientAccounts[loginid] = {
                loginid,
                token: trimmed,
                currency: authorize.currency ?? 'USD',
            };

            // Also add any additional accounts from account_list if present
            if (Array.isArray(authorize.account_list)) {
                authorize.account_list.forEach((acc: { loginid: string; token?: string; currency?: string }) => {
                    if (acc.loginid !== loginid && acc.token) {
                        accountsList[acc.loginid] = acc.token;
                        clientAccounts[acc.loginid] = {
                            loginid: acc.loginid,
                            token: acc.token,
                            currency: acc.currency ?? 'USD',
                        };
                    }
                });
            }

            // Write to localStorage — same keys as OAuth/AuthWrapper
            localStorage.setItem('accountsList', JSON.stringify(accountsList));
            localStorage.setItem('clientAccounts', JSON.stringify(clientAccounts));
            localStorage.setItem('authToken', trimmed);
            localStorage.setItem('active_loginid', loginid);

            setState('success');

            // Disconnect the validation socket (app will create its own)
            try {
                (api as any).disconnect();
            } catch (_) {
                // ignore
            }

            // Short delay so user sees the success state, then reload to trigger full auth
            setTimeout(() => {
                window.location.reload();
            }, 800);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('timeout') || msg.includes('Connection')) {
                setErrorMessage(
                    localize('Could not connect to Deriv servers. Please check your internet connection.')
                );
            } else {
                setErrorMessage(localize('An unexpected error occurred. Please try again.'));
            }
            setState('error');

            // Clean up socket on error
            try {
                (api as any)?.disconnect?.();
            } catch (_) {
                // ignore
            }
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
