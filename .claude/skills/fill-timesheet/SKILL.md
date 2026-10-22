---
name: fill-timesheet
description: "Fill in Jira timesheets by running this skill's scripts/timesheets.py, which auto-logs worklogs to Jira based on GitHub commit history. Use when user asks to fill their timesheet, log time in Jira, run the timesheet script, or catch up on worklogs."
argument-hint: "(no arguments needed)"
---

# Fill Timesheet

Run `scripts/timesheets.py` (in this skill's directory) for user. Script auto-adds Jira worklogs from git commit history, skip weekends/holidays/leave.

## What script does

1. Finds user's most recent Jira worklog (last 365 days) → start date = day after.
2. Loops workdays from there to current date.
3. Skips public holidays (AU, via Nager.Date API) and `EXCLUDED_DATES`.
4. For each workday, finds nearest GitHub commit (by ticket key in message, regex `(wc|scn|sx|cr)-\d+`), walks up to top parent epic, logs `6h 30m` to that epic + `1h` admin time to `CR-338`.
5. Searches these repos: ContractReview, DocumentTransformationService, InfoTrack.Platform.Core.DocumentExtraction, InfoTrack.Platform.Core.DocumentClassification, SmartContracts, QldSellerDisclosure.

Full docs: https://infotrack.atlassian.net/wiki/spaces/Contracts/pages/3201433712/How+to+use+the+jira+tracking+script

## Procedure

### 1. Check prerequisites

Working dir: this skill's directory, `.claude/skills/fill-timesheet/`.

Check for venv (`venv/` folder). If missing:
```bash
python -m venv venv
```
> Note for user: may need Netskope disabled for venv creation.

Activate + install deps:

Windows:
```bash
.\venv\Scripts\activate
pip install -r requirements.txt
```

Mac/Linux:
```bash
source venv/bin/activate
pip install -r requirements.txt
```

### 2. Check env vars

Script loads `.env` via `python-dotenv`. Required vars — script crashes (`AttributeError` on `.split`) if `EXCLUDED_DATES` unset, so all must exist even if empty:

| Var | Required | Purpose | How to get |
|---|---|---|---|
| `JIRA_USERNAME` | yes | Jira Basic Auth username | user's InfoTrack email |
| `JIRA_TOKEN` | yes | Jira Basic Auth token | Atlassian → Account Settings → Security → API tokens → Create |
| `GITHUB_AUTHOR` | yes | filters commits by author | user's GitHub username |
| `GITHUB_TOKEN` | yes | GitHub API auth (commit history) | GitHub → Settings → Developer settings → Personal access tokens → generate (needs `repo` read scope for the repos listed above) |
| `EXCLUDED_DATES` | yes (can be empty string) | comma-separated `YYYY-MM-DD` dates to skip (leave/sick) | ask user for any leave dates in the target window |
| `STATE` | no (defaults `NSW`) | AU state code, filters public holidays | ask user's state, e.g. `NSW`, `VIC` |

Check `.env` exists in this skill's directory (git-ignored, safe to write secrets there — never print token values back or log them). `.env.example` lists every key; shell environment variables take precedence over `.env`.

If `.env` missing or a var is missing:
- Ask user for each missing value one at a time via AskUserQuestion where sensible (e.g. STATE as a pick-list of AU states), plain question for tokens/usernames.
- **Never ask the user to paste a token value into chat that gets echoed back — direct entry is fine, just don't echo it in your response.**
- Write/append to `.env` in `KEY=value` format. Create file if absent (copy `.env.example`).
- If EXCLUDED_DATES has no leave taken, set `EXCLUDED_DATES=` (empty).
- User may supply leave dates as screenshot (e.g. Jira leave-request table with Start date/End date columns) instead of typing. Read image, extract each Start/End pair, convert `DD Mon YYYY` → `YYYY-MM-DD`, expand multi-day ranges into individual calendar dates, dedupe, comma-join into `EXCLUDED_DATES`.

### 3. Run script

Run from this skill's directory so `.env` is picked up.

Windows:
```bash
cd .claude\skills\fill-timesheet
.\venv\Scripts\activate
python .\scripts\timesheets.py
```

Mac/Linux:
```bash
cd .claude/skills/fill-timesheet
source venv/bin/activate
python scripts/timesheets.py
```

Script prints progress per workday (ticket, epic, time logged) — relay a summary to user, don't dump raw output.

### 4. Report

Summarise: date range processed, tickets/epics logged, any skipped days (script logs each skip reason separately: `public holiday`, `personal leave`, or `public holiday + personal leave`; also `no commits found`), and any failed worklog calls (non-201 responses printed by script).

Give user link to verify: https://infotrack.atlassian.net/jira/apps/8ffef003-1734-4582-9850-7b90bd2a3a3b/ae2a0a76-45fb-481d-a48a-ecbeec74daf5/main/pages/aiotimeentry

## Notes

- Script has no `--dry-run` — it posts worklogs directly to Jira on run. Confirm date range/repos look right with user before running if this is their first time.
- If script matches wrong ticket for a day, user should manually correct worklog in Jira after — script doesn't support editing.
- Network: script calls `infotrack.atlassian.net`, `api.github.com` and `date.nager.at`. In a cloud environment these must be in the allowed domains.
