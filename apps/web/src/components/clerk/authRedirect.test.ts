import { describe, expect, it } from "vite-plus/test";

import { resolveClerkSignInProps } from "./authRedirect";

describe("resolveClerkSignInProps", () => {
  it("returns to the current browser URL on the web", () => {
    const href = "https://app.t3.codes/connect?state=state-1#details";
    expect(resolveClerkSignInProps(href, false)).toEqual({
      forceRedirectUrl: href,
      signUpForceRedirectUrl: href,
    });
  });

  it("lets the Electron SDK provide the native redirect", () => {
    expect(
      resolveClerkSignInProps(
        "t3code://app/CLERK-ROUTER/VIRTUAL/sign-up?__clerk_status=complete#/settings/connections",
        true,
      ),
    ).toEqual({});
  });

  it("also omits the override for development desktop", () => {
    expect(resolveClerkSignInProps("t3code-dev://app/#/settings/general", true)).toEqual({});
  });
});
