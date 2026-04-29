import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// ======================
//  Configuration for Vercel Serverless Function
// ======================
export const config = {
  api: { bodyParser: false },
  supportsResponseStreaming: true,
  maxDuration: 60,
};

// Target backend configuration
// This is the base URL of the destination server (Xray/V2Ray core)
// It is loaded from environment variable TARGET_DOMAIN
const TARGET_BASE_URL = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");

// List of headers that should be removed before forwarding the request
// These headers are either related to the original connection or can cause conflicts
// when forwarding through Vercel and proxy systems
const HEADERS_TO_STRIP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
]);

// Main request handler function
// This is the entry point for all incoming HTTP requests on Vercel
export default async function handler(req, res) {
  if (!TARGET_BASE_URL) {
    res.statusCode = 500;
    return res.end("Misconfigured: TARGET_DOMAIN is not set");
  }

  try {
    // Construct the full target URL by appending the original request path and query
    // to the base URL of the upstream server
    const targetUrl = TARGET_BASE_URL + req.url;

    const forwardedHeaders = {};
    let clientIp = null;

    // Process all incoming request headers
    // We clean and filter headers to prevent conflicts and security issues
    // Also extract real client IP from Vercel headers
    for (const key of Object.keys(req.headers)) {
      const lowerKey = key.toLowerCase();
      const value = req.headers[key];

      if (HEADERS_TO_STRIP.has(lowerKey)) continue;
      if (lowerKey.startsWith("x-vercel-")) continue;

      if (lowerKey === "x-real-ip") {
        clientIp = value;
        continue;
      }
      if (lowerKey === "x-forwarded-for") {
        if (!clientIp) clientIp = value;
        continue;
      }

      forwardedHeaders[lowerKey] = Array.isArray(value) ? value.join(", ") : value;
    }

    // Add the real client IP to the forwarded headers so the backend can see it
    if (clientIp) {
      forwardedHeaders["x-forwarded-for"] = clientIp;
    }

    const method = req.method;
    const hasBody = method !== "GET" && method !== "HEAD";

    // Prepare the options object for the fetch request to the upstream server
    const fetchOptions = {
      method,
      headers: forwardedHeaders,
      redirect: "manual"
    };

    // If the request has a body (POST, PUT, PATCH, etc.), convert the Node.js stream
    // to a web stream so it can be sent with fetch
    if (hasBody) {
      fetchOptions.body = Readable.toWeb(req);
      fetchOptions.duplex = "half";
    }

    // Send the request to the target upstream server (Xray/V2Ray)
    const upstreamResponse = await fetch(targetUrl, fetchOptions);

    // Set the same HTTP status code received from the upstream server
    res.statusCode = upstreamResponse.status;

    // Forward all response headers from upstream to the client
    // We skip "transfer-encoding" because Vercel handles streaming differently
    for (const [key, value] of upstreamResponse.headers) {
      if (key.toLowerCase() === "transfer-encoding") continue;
      try {
        res.setHeader(key, value);
      } catch (e) {}
    }

    // Stream the response body from upstream directly to the client
    // This enables efficient streaming without loading everything into memory
    if (upstreamResponse.body) {
      await pipeline(Readable.fromWeb(upstreamResponse.body), res);
    } else {
      res.end();
    }

  } catch (error) {
    console.error("Relay error:", error);

    // Return a proper error response if something goes wrong during proxying
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end("Bad Gateway: Tunnel Failed");
    }
  }
}
