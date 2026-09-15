import axios from "axios";
import { bitrixUrls, config } from "./config.js";
import { getEmployeeById, saveTokens } from "./db.js";

const REFRESH_MARGIN_SECONDS = 60;

async function refreshAccessToken(employee) {
  const { data } = await axios.get(bitrixUrls.token, {
    params: {
      grant_type: "refresh_token",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: employee.refresh_token,
    },
  });

  saveTokens(employee.api_key, {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
  });

  return data.access_token;
}

export async function getValidAccessToken(employee) {
  if (!employee.refresh_token) {
    throw new Error(
      `Employee "${employee.name}" has not completed Bitrix24 OAuth login yet. Send them the /oauth/start link.`
    );
  }

  const now = Math.floor(Date.now() / 1000);
  if (employee.expires_at && employee.expires_at - now > REFRESH_MARGIN_SECONDS) {
    return employee.access_token;
  }

  return refreshAccessToken(employee);
}

export async function callBitrix(employeeId, method, params = {}) {
  const employee = getEmployeeById(employeeId);
  if (!employee) throw new Error("Unknown employee");

  const accessToken = await getValidAccessToken(employee);

  const { data } = await axios.post(bitrixUrls.rest(method), params, {
    params: { auth: accessToken },
  });

  if (data.error) {
    throw new Error(`Bitrix24 API error (${data.error}): ${data.error_description}`);
  }

  return data.result;
}
