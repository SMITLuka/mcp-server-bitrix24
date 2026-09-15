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
