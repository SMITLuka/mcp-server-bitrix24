import express from "express";
import { config, bitrixUrls } from "./config.js";

// oidc-provider redirects the browser here whenever a Claude Custom Connector
// login needs a human. We skip any UI of our own and bounce straight into
// Bitrix24's login screen, tagging the OAuth `state` so /oauth/callback knows
// to resume this OIDC interaction (see oauth.js) instead of the legacy
// static-API-key flow.
export function createInteractionRouter(provider) {
  const router = express.Router();

  router.get("/interaction/:uid", async (req, res, next) => {
    try {
      const details = await provider.interactionDetails(req, res);
      const { prompt, params } = details;

      // After Bitrix24 login succeeds, oidc-provider comes back here a
      // second time asking for "consent" (approval of the requested
      // scopes) before it will finish the /auth request. This is an
      // internal company tool with one connector, so we auto-approve
      // instead of showing a second manual screen - without this, our
      // code below would blindly bounce the already-logged-in user back
      // to Bitrix again, which immediately returns a fresh code and
      // creates an infinite redirect loop.
      if (prompt.name === "consent") {
        const grant = details.grantId
          ? await provider.Grant.find(details.grantId)
          : new provider.Grant({ accountId: details.session.accountId, clientId: params.client_id });

        if (prompt.details.missingOIDCScope?.length) {
          grant.addOIDCScope(prompt.details.missingOIDCScope.join(" "));
        }
        if (prompt.details.missingResourceScopes) {
          for (const [indicator, scopes] of Object.entries(prompt.details.missingResourceScopes)) {
            grant.addResourceScope(indicator, scopes.join(" "));
          }
        }

        const grantId = await grant.save();
        return await provider.interactionFinished(
          req,
          res,
          { consent: { grantId } },
          { mergeWithLastSubmission: true }
        );
      }

      // oidc-provider scopes its own `_interaction` session cookie to this
      // exact path (/interaction/<uid>), so it won't be sent back once the
      // browser returns from Bitrix24 to the fixed /oauth/callback path
      // instead. Without it, interactionFinished() there has no way to know
      // which interaction to resume. Duplicate the cookie, scoped to the
      // callback path, so it survives the round trip.
      res.cookie("_interaction", details.uid, {
        path: "/oauth/callback",
        httpOnly: true,
        sameSite: "lax",
        secure: true,
      });

      const authorizeUrl = new URL(bitrixUrls.authorize);
      authorizeUrl.searchParams.set("client_id", config.clientId);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("redirect_uri", `${config.baseUrl}/oauth/callback`);
      authorizeUrl.searchParams.set("state", `oidc:${details.uid}`);

      res.redirect(authorizeUrl.toString());
    } catch (err) {
      next(err);
    }
  });

  return router;
}
