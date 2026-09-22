import Huggingface from "@auth/core/providers/huggingface";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { convexAuth } from "@convex-dev/auth/server";
import { sandboxEnabled } from "./sandbox";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    ...(sandboxEnabled() ? [Anonymous({
      profile: () => ({
        isAnonymous: true,
        name: "Sandbox reviewer",
        username: `sandbox-${crypto.randomUUID()}`,
      }),
    })] : []),
    Huggingface({
      // "openid profile" only — the allowlist keys on the OIDC sub, and
      // omitting "email" means the OAuth app does not need the email scope.
      authorization: { params: { scope: "openid profile" } },
      profile(profile) {
        return {
          id: profile.sub,
          name: (profile.name as string) ?? (profile.preferred_username as string),
          username: profile.preferred_username as string,
          image: profile.picture as string | undefined,
        };
      },
    }),
  ],
});
