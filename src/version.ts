declare const ASL_LANGUAGE_SERVER_VERSION: string

// The build defines the release's version. Run from source, the server reports `dev`.
export const VERSION = typeof ASL_LANGUAGE_SERVER_VERSION === 'string' ? ASL_LANGUAGE_SERVER_VERSION : 'dev'
