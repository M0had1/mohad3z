import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginSass } from '@rsbuild/plugin-sass';

const path = require('path');

// Determine if we're running in a Netlify/CI environment (no HTTPS needed)
const isCI = process.env.CI === 'true' || process.env.NETLIFY === 'true';

// Helper: return env var or empty string fallback (prevents build crashes for missing secrets)
const env = (key: string, fallback = '') => process.env[key] || fallback;

export default defineConfig({
    plugins: [
        pluginSass({
            sassLoaderOptions: {
                sourceMap: !isCI,
                sassOptions: {},
            },
            exclude: /node_modules/,
        }),
        pluginReact(),
        // Only use SSL plugin in local dev — Netlify handles TLS itself
        ...(isCI ? [] : [require('@rsbuild/plugin-basic-ssl').pluginBasicSsl()]),
    ],
    source: {
        entry: {
            index: './src/main.tsx',
        },
        define: {
            'process.env': {
                // Core build vars
                APP_ENV: JSON.stringify(env('APP_ENV', 'production')),
                REF_NAME: JSON.stringify(env('REF_NAME', 'main')),
                NETLIFY: JSON.stringify(env('NETLIFY', '')),

                // Translations CDN — falls back to Deriv's public CDN if not set
                TRANSLATIONS_CDN_URL: JSON.stringify(env('TRANSLATIONS_CDN_URL', 'https://cdn.deriv.com')),
                R2_PROJECT_NAME: JSON.stringify(env('R2_PROJECT_NAME', 'bot')),
                CROWDIN_BRANCH_NAME: JSON.stringify(env('CROWDIN_BRANCH_NAME', 'production')),

                // Remote config
                REMOTE_CONFIG_URL: JSON.stringify(env('REMOTE_CONFIG_URL', '')),

                // Google Drive integration — optional, safe to leave empty
                GD_CLIENT_ID: JSON.stringify(env('GD_CLIENT_ID', '')),
                GD_APP_ID: JSON.stringify(env('GD_APP_ID', '')),
                GD_API_KEY: JSON.stringify(env('GD_API_KEY', '')),

                // Error monitoring — optional, disabled when empty
                TRACKJS_TOKEN: JSON.stringify(env('TRACKJS_TOKEN', '')),
                DATADOG_APPLICATION_ID: JSON.stringify(env('DATADOG_APPLICATION_ID', '')),
                DATADOG_CLIENT_TOKEN: JSON.stringify(env('DATADOG_CLIENT_TOKEN', '')),
                DATADOG_SESSION_REPLAY_SAMPLE_RATE: JSON.stringify(env('DATADOG_SESSION_REPLAY_SAMPLE_RATE', '0')),
                DATADOG_SESSION_SAMPLE_RATE: JSON.stringify(env('DATADOG_SESSION_SAMPLE_RATE', '0')),

                // Analytics — optional, disabled when empty
                RUDDERSTACK_KEY: JSON.stringify(env('RUDDERSTACK_KEY', '')),

                // Feature flags — optional, disabled when empty
                GROWTHBOOK_CLIENT_KEY: JSON.stringify(env('GROWTHBOOK_CLIENT_KEY', '')),
                GROWTHBOOK_DECRYPTION_KEY: JSON.stringify(env('GROWTHBOOK_DECRYPTION_KEY', '')),
            },
        },
        alias: {
            react: path.resolve('./node_modules/react'),
            'react-dom': path.resolve('./node_modules/react-dom'),
            '@/external': path.resolve(__dirname, './src/external'),
            '@/components': path.resolve(__dirname, './src/components'),
            '@/hooks': path.resolve(__dirname, './src/hooks'),
            '@/utils': path.resolve(__dirname, './src/utils'),
            '@/constants': path.resolve(__dirname, './src/constants'),
            '@/stores': path.resolve(__dirname, './src/stores'),
        },
    },
    output: {
        copy: [
            {
                from: 'node_modules/@deriv/deriv-charts/dist/*',
                to: 'js/smartcharts/[name][ext]',
                globOptions: {
                    ignore: ['**/*.LICENSE.txt'],
                },
            },
            { from: 'node_modules/@deriv/deriv-charts/dist/chart/assets/*', to: 'assets/[name][ext]' },
            { from: 'node_modules/@deriv/deriv-charts/dist/chart/assets/fonts/*', to: 'assets/fonts/[name][ext]' },
            { from: 'node_modules/@deriv/deriv-charts/dist/chart/assets/shaders/*', to: 'assets/shaders/[name][ext]' },
            { from: path.join(__dirname, 'public') },
        ],
        // Ensure service worker is not cached by the browser
        filename: {
            js: ({ chunk }) => {
                // Don't add hash to service worker
                if (chunk?.name === 'sw') {
                    return '[name].js';
                }
                return '[name].[contenthash:8].js';
            },
        },
    },
    html: {
        template: './index.html',
    },
    server: {
        port: 8443,
        compress: true,
        // Use plain HTTP in CI/Netlify; HTTPS locally via pluginBasicSsl
        https: isCI ? false : undefined,
        headers: {
            'Cross-Origin-Opener-Policy': 'unsafe-none',
            'Cross-Origin-Embedder-Policy': 'unsafe-none',
        },
    },
    dev: {
        hmr: true,
    },
    tools: {
        rspack: {
            plugins: [],
            resolve: {},
            module: {
                rules: [
                    {
                        test: /\.xml$/,
                        exclude: /node_modules/,
                        use: 'raw-loader',
                    },
                ],
            },
        },
    },
});
