// Better Stack heartbeat states for check:heartbeats. Node standard library only: the check jobs
// run without node_modules.
//
// API (https://betterstack.com/docs/uptime/api/list-all-existing-hearbeats/; re-check the field
// names there before the first live check, the docs could not be fetched when this was written):
// GET https://incidents.betterstack.com/api/v2/heartbeats with `Authorization: Bearer <token>`;
// each item's `attributes.name` and `attributes.status` (paused | pending | up | down); paginated
// by `pagination.next`. Each item also carries its ping URL, which this module never returns or
// prints, and the token is never printed.

export const HEARTBEATS_API = "https://incidents.betterstack.com/api/v2/heartbeats";

/** The heartbeat name OpenTofu gives a cell (infra/tofu/main.tf). */
export const heartbeatName = (cell) => `secbot ${cell} cell`;

/** Name and status of every heartbeat, without URLs. Pure. */
export function heartbeatStatuses(pages) {
  const statuses = new Map();
  for (const page of pages) {
    for (const item of page?.data ?? []) {
      const name = item?.attributes?.name;
      if (typeof name === "string") statuses.set(name, String(item.attributes.status ?? "unknown"));
    }
  }
  return statuses;
}

/** Reads every page of the heartbeat list; at most 20 pages. */
export async function fetchHeartbeatStatuses(token, fetcher = fetch) {
  if (!token) {
    throw new Error(
      "HEARTBEAT_API_TOKEN is not set (the Better Stack API token, from your shell or the environment's secret)",
    );
  }
  const pages = [];
  let next = HEARTBEATS_API;
  for (let count = 0; next && count < 20; count++) {
    if (!/^https:\/\/(incidents|uptime)\.betterstack\.com\//.test(next)) {
      throw new Error(
        "the heartbeat list pointed to another host; refusing to send the token there",
      );
    }
    const response = await fetcher(next, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(`the Better Stack heartbeat list answered ${response.status}`);
    const page = await response.json();
    pages.push(page);
    next = page?.pagination?.next ?? null;
  }
  return heartbeatStatuses(pages);
}
