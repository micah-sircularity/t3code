export interface ClerkSignInProps {
  forceRedirectUrl?: string;
  signUpForceRedirectUrl?: string;
}

export function resolveClerkSignInProps(href: string, isElectron: boolean): ClerkSignInProps {
  // Clerk's native-app allowlist only authorizes the bare renderer root,
  // which @clerk/electron's OAuth transport already supplies. A page-derived
  // redirect override causes the native sign-in request to be rejected.
  if (isElectron) return {};

  // The sign-in modal can switch to sign-up, which follows its own redirect
  // target; without one Clerk falls back to the URL the modal was opened from.
  return { forceRedirectUrl: href, signUpForceRedirectUrl: href };
}
