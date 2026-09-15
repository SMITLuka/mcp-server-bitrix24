import express from "express";
import axios from "axios";
import { bitrixUrls, config } from "./config.js";
import { getEmployeeByApiKey, saveTokens, findOrCreateAccountByBitrixUser, saveTokensById } from "./db.js";

const redirectUri = `${config.baseUrl}/oauth/callback`;

async function exchangeCodeForBitrixTokens(code) {
  const { data: tokenData } = await axios.get(bitrixUrls.token, {
    params: {
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
    },
  });

  if (tokenData.error) {
    throw new Error(tokenData.error_description || tokenData.error);
  }

  if (!tokenData.access_token || !tokenData.refresh_token) {
    throw new Error(
      `Unexpected token response shape from Bitrix24 (missing access_token/refresh_token). Raw response: ${JSON.stringify(tokenData)}`
    );
  }

  return tokenData;
}

async function fetchBitrixUser(accessToken) {
  try {
    const { data } = await axios.post(bitrixUrls.rest("user.current"), {}, { params: { auth: accessToken } });
    if (!data.result) return { id: null, name: null };
    return {
      id: String(data.result.ID),
      name: `${data.result.NAME || ""} ${data.result.LAST_NAME || ""}`.trim(),
    };
  } catch {
    return { id: null, name: null };
  }
}

// `provider` is optional: it's only needed to resume a Claude Custom
// Connector (OIDC) login. The legacy personal-link flow (/oauth/start) works
// without it.
export function createOauthRouter(provider) {
  const router = express.Router();

  // Link an employee visits once to connect their own Bitrix24 account
  // (legacy flow: a manually issued, static API key from add-employee.js).
  router.get("/start", (req, res) => {
    const apiKey = req.query.key;
    const employee = apiKey && getEmployeeByApiKey(apiKey);
    if (!employee) {
      return res.status(404).send("Unknown or missing API key. Ask the MCP server admin for your personal link.");
    }

    const authorizeUrl = new URL(bitrixUrls.authorize);
    authorizeUrl.searchParams.set("client_id", config.clientId);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("state", apiKey);

    res.redirect(authorizeUrl.toString());
  });

  router.get("/callback", async (req, res) => {
    const { code, state, error, error_description } = req.query;

    if (error) {
      return res.status(400).send(`Bitrix24 returned an error: ${error} - ${error_description || ""}`);
    }

    const isOidcInteraction = typeof state === "string" && state.startsWith("oidc:");

    try {
      const tokenData = await exchangeCodeForBitrixTokens(code);
      const bitrixUser = await fetchBitrixUser(tokenData.access_token);

      if (isOidcInteraction) {
        if (!provider) {
          throw new Error("OIDC provider is not configured on this server.");
        }
        if (!bitrixUser.id) {
          throw new Error("Could not identify the Bitrix24 user (user.current failed).");
        }

        const accountId = findOrCreateAccountByBitrixUser(bitrixUser.id, bitrixUser.name);
        saveTokensById(accountId, {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_in: tokenData.expires_in,
          bitrix_user_id: bitrixUser.id,
          bitrix_user_name: bitrixUser.name,
        });

        // Hands control back to oidc-provider, which issues its own
        // authorization code and redirects the browser back to Claude.
        return await provider.interactionFinished(
          req,
          res,
          { login: { accountId: bitrixUser.id } },
          { mergeWithLastSubmission: false }
        );
      }

      const employee = getEmployeeByApiKey(String(state));
      if (!employee) {
        return res.status(400).send("Invalid or expired session. Ask for a fresh personal link.");
      }

      saveTokens(employee.api_key, {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_in: tokenData.expires_in,
        bitrix_user_id: bitrixUser.id,
        bitrix_user_name: bitrixUser.name,
      });

      res.send(
        `<p>Bitrix24 account connected${bitrixUser.name ? ` as <b>${bitrixUser.name}</b>` : ""}. You can close this tab and return to Claude Code.</p>`
      );
    } catch (err) {
      res.status(500).send(`Failed to complete Bitrix24 login: ${err.message}`);
    }
  });

  return router;
}
