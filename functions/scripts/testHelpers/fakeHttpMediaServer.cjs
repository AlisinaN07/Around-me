/**
 * Step 9A — a tiny, real, localhost-only HTTP server used ONLY by this
 * repo's own test suite, standing in for R2's public delivery endpoint so
 * downloadReelSourceToLocalFile/copyReelSourceToFirebaseStoryObject's own
 * `fetch(sourceUrl)` step can be exercised against a REAL HTTP round trip
 * (real sockets, real status codes, real bytes) instead of a mocked
 * `fetch` function — closer to the real R2 behavior than a pure stub,
 * without needing real Cloudflare credentials or network access.
 *
 * Supports exactly what these tests need: GET a fixed path returns
 * pre-registered bytes (200) or 404 for anything else, and a PUT/DELETE
 * pair against an in-memory object store, mirroring R2's own
 * presigned-PUT + object-key semantics closely enough to sanity-check the
 * request/response SHAPES this codebase's own upload code depends on
 * (status codes, method, body-arrives-intact) — see this file's own doc
 * comment on `startFakeR2Server` for the PUT/DELETE object-store variant.
 *
 * Never used by, or reachable from, any production code path — this file
 * lives under functions/scripts/ (test tooling only, not deployed) and is
 * required only by other test scripts in this same directory.
 */
const http = require('node:http');

/**
 * Starts a minimal fake "R2 public delivery" server: GET on any
 * registered path returns that path's bytes with `200`; GET on anything
 * else returns `404`. Returns `{ url(path), close() }` — `url()` builds a
 * full `http://127.0.0.1:<port>/<path>` string suitable for the R2
 * public-URL role in a test.
 */
function startFakeDeliveryServer(routes) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const path = req.url;
      const entry = routes[path];
      if (req.method !== 'GET' || !entry) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(entry.status ?? 200, entry.headers ?? {});
      res.end(entry.body);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: (path) => `http://127.0.0.1:${port}${path}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/**
 * Starts a fake R2-object-store server backing an in-memory `Map<key,
 * Buffer>` — supports PUT (stores the request body under the URL path),
 * GET (200 + stored bytes, or 404 if absent), and DELETE (removes the
 * key, always 204 — mirroring S3/R2's own idempotent-delete semantics:
 * deleting a nonexistent key is not an error). Exposes `objects` (the
 * live Map, inspectable directly from a test) alongside `url()`/`close()`.
 */
function startFakeR2ObjectServer() {
  const objects = new Map();
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const key = req.url;
      if (req.method === 'PUT') {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          objects.set(key, Buffer.concat(chunks));
          res.writeHead(200);
          res.end();
        });
        return;
      }
      if (req.method === 'GET') {
        const body = objects.get(key);
        if (!body) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200);
        res.end(body);
        return;
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(405);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        objects,
        url: (path) => `http://127.0.0.1:${port}${path}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { startFakeDeliveryServer, startFakeR2ObjectServer };
