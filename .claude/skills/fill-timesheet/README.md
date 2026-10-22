# Fill timesheet skill

Auto-logs Jira worklogs from your GitHub commit history, on demand via `/fill-timesheet`.
Ported from the `fill-timesheet` skill and `jiraAutomation/Timesheets/timesheets.py` in the
SmartContracts repo so it is self-contained here.

What a run does:

- Finds your most recent Jira worklog (last 365 days) and starts from the day after.
- Walks every weekday up to today, skipping AU public holidays for your state (Nager.Date API)
  and any personal leave dates in `EXCLUDED_DATES`.
- For each remaining day, picks the nearest commit of yours (by `(WC|SCN|SX|CR)-123` ticket key
  in the message) across the InfoTrack repos listed in `scripts/timesheets.py`, walks up to the
  top parent epic, and logs `6h 30m` to that epic plus `1h` admin time to `CR-338`.

There is no dry-run: it posts worklogs straight to Jira. Fix any wrong day manually in Jira.

## One-off setup

1. **Credentials** — copy `.env.example` to `.env` (gitignored) and fill in `JIRA_USERNAME`,
   `JIRA_TOKEN`, `GITHUB_AUTHOR`, `GITHUB_TOKEN`, `EXCLUDED_DATES` (may be empty) and `STATE`.
   Every key must exist or the script crashes on start. Shell variables take precedence over
   `.env`. Never commit `.env`.
2. **Python** — create a venv in this directory and install the two dependencies:

   ```bash
   python -m venv venv            # may need Netskope disabled
   .\venv\Scripts\activate        # Windows
   source venv/bin/activate       # Mac/Linux
   pip install -r requirements.txt
   ```
3. **Network** (cloud sessions only) — allow `infotrack.atlassian.net`, `api.github.com` and
   `date.nager.at` in the environment settings.

## Run it

From this directory, with the venv active:

```bash
python scripts/timesheets.py
```

Then verify in Jira:
https://infotrack.atlassian.net/jira/apps/8ffef003-1734-4582-9850-7b90bd2a3a3b/ae2a0a76-45fb-481d-a48a-ecbeec74daf5/main/pages/aiotimeentry

Full docs:
https://infotrack.atlassian.net/wiki/spaces/Contracts/pages/3201433712/How+to+use+the+jira+tracking+script

## Where the skill lives

This folder is `.claude/skills/fill-timesheet/`, so any session on this branch loads it. Its own
`.gitignore` keeps `.env`, `venv/` and Python caches out of git.
