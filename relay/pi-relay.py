#!/usr/bin/env python3
"""Election-night relay for states that refuse cloud servers, run from a home network by cron every two minutes.

Ohio's and Virginia's results sites turn away the AWS recorder (HTTP 403) but answer a home connection, so this reads
them from the Raspberry Pi and drops the responses, unparsed, into the recorder's S3 bucket as relay.json (gzipped).
The bucket accepts that one object only from the home network's IP address (aws/needle-template.yaml), so the Pi holds
no AWS keys. The recorder parses it with the same code it uses for every other state (ingest/senate-returns.js) and falls
back to the race's Wikipedia count if this goes quiet. Python standard library only.

Installed on the Pi in ~/election-relay with this crontab line (flock keeps two runs from overlapping):

    */2 * * * * flock -n /tmp/election-relay.lock /usr/bin/python3 ~/election-relay/pi-relay.py >> ~/election-relay/relay.log 2>&1
"""
import gzip
import json
import urllib.error
import urllib.request
from datetime import datetime, timezone

USER_AGENT = "election-tracker-relay/1.0 (texas-race-tracker.vercel.app; derekensign@gmail.com)"
BUCKET_OBJECT = "https://election-tracker-needle-needlebucket-92bzmtfdaxc0.s3.us-east-1.amazonaws.com/relay.json"
# The recorder stops at 8 a.m. Central on November 4; after that every run does nothing.
STOP_AFTER = datetime(2026, 11, 4, 14, 0, tzinfo=timezone.utc)
SOURCES = {
    "OH": "https://liveresults.ohiosos.gov/Api/v1/Contest/GetContestDetailsObject?contestName=U.S.%20Senator&contestObjectId=_55A742EA56A709A3E0633390EE0AE290",
    "VA": "https://enr.elections.virginia.gov/results/public/api/elections/virginia/2026-November-General/data",
}


def read(url: str) -> tuple[int, str]:
    """A URL's status and text, with the relay's own User-Agent."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=40) as response:
        return response.status, response.read().decode("utf-8", "replace")


def main() -> None:
    now = datetime.now(timezone.utc)
    if now > STOP_AFTER:
        return
    files: dict[str, dict] = {}
    for state, url in SOURCES.items():
        fetched_at = datetime.now(timezone.utc).isoformat()
        try:
            status, body = read(url)
            files[state] = {"url": url, "status": status, "fetchedAt": fetched_at, "body": body}
        except urllib.error.HTTPError as error:
            files[state] = {"url": url, "status": error.code, "fetchedAt": fetched_at, "error": f"HTTP {error.code}"}
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            files[state] = {"url": url, "fetchedAt": fetched_at, "error": str(error)[:200]}
    payload = gzip.compress(json.dumps({"kind": "senate-relay", "relayedAt": now.isoformat(), "files": files}).encode("utf-8"))
    put = urllib.request.Request(BUCKET_OBJECT, data=payload, method="PUT", headers={"Content-Type": "application/json", "Content-Encoding": "gzip"})
    with urllib.request.urlopen(put, timeout=30) as response:
        summary = {state: file.get("error") or file.get("status") for state, file in files.items()}
        print(f"{now.isoformat()} relayed {summary} ({len(payload)} bytes) -> S3 {response.status}", flush=True)


if __name__ == "__main__":
    main()
