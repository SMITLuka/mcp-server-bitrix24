import express from "express";
import axios from "axios";
import { bitrixUrls, config } from "./config.js";
import { getEmployeeByApiKey, saveTokens } from "./db.js";

export const oauthRouter = express.Router();

const redirectUri = `${config.baseUrl}/oauth/callback`;

// Link an employee visits once to connect their own Bitrix24 account.
oauthRouter.get("/start", (req, res) => {
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

oauthRouter.get("/callback", async (req, res) => {
  const { code, state: apiKey, error, error_description } = req.query;

  if (error) {
    return res.status(400).send(`Bitrix24 returned an error: ${error} - ${error_description || ""}`);
  }

  const employee = apiKey && getEmployeeByApiKey(String(apiKey));
  if (!employee) {
    return res.status(400).send("Invalid or expired session. Ask for a fresh personal link.");
  }

  try {
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

    console.log("Bitrix24 token response keys:", Object.keys(tokenData));

    if (!tokenData.access_token || !tokenData.refresh_token) {
      throw new Error(
        `Unexpected token response shape from Bitrix24 (missing access_token/refresh_token). Raw response: ${JSON.stringify(tokenData)}`
      );
    }

    let bitrixUserId = null;
    let bitrixUserName = null;
    try {
      const { data: userData } = await axios.post(
        bitrixUrls.rest("user.current"),
        {},
        { params: { auth: tokenData.access_token } }
      );
      if (userData.result) {
        bitrixUserId = String(userData.result.ID);
        bitrixUserName = `${userData.result.NAME || ""} ${userData.result.LAST_NAME || ""}`.trim();
      }
    } catch {
      // Non-fatal: tokens are still valid even if we couldn't label the user yet.
    }

    saveTokens(employee.api_key, {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
      bitrix_user_id: bitrixUserId,
      bitrix_user_name: bitrixUserName,
    });

    res.send(
      `<p>Bitrix24 account connected${bitrixUserName ? ` as <b>${bitrixUserName}</b>` : ""}. You can close this tab and return to Claude Code.</p>`
    );
  } catch (err) {
    res.status(500).send(`Failed to complete Bitrix24 login: ${err.message}`);
  }
});
