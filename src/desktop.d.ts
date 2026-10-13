export {};

declare global {
  interface Window {
    handoffDesktop?: {
      signInWithGoogle(): Promise<{ access_token: string; refresh_token: string }>;
    };
  }
}
