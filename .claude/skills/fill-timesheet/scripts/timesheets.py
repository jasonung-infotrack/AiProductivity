from datetime import datetime, timedelta
from dotenv import load_dotenv
from requests.auth import HTTPBasicAuth
import json
import os
import re
import requests

load_dotenv()
jira_url = "https://infotrack.atlassian.net/rest/api/3"
jira_username = os.getenv("JIRA_USERNAME")
jira_token = os.getenv("JIRA_TOKEN")
github_author = os.getenv("GITHUB_AUTHOR")
github_token = os.getenv("GITHUB_TOKEN")
# personal/sick leave dates
excluded_dates = os.getenv("EXCLUDED_DATES").split(",")
state = os.getenv("STATE")
print(f"Running script for state: {state}")
if not state:
    state = "NSW"


def get_public_holidays(years):
    """
    Fetch public holidays from the Nager.Date API for the specified years.
    Returns a list of holiday dates in 'YYYY-MM-DD' format.
    """
    holiday_dates = []
    for year in years:
        try:
            url = f"https://date.nager.at/api/v3/PublicHolidays/{year}/AU"
            response = requests.get(url, timeout=10)
            if response.status_code == 200:
                holidays = response.json()
                # Filter by state if needed - the API returns counties field
                for holiday in holidays:
                    # Add all national holidays and those specific to the state
                    counties = holiday.get("counties")
                    holiday_date = holiday["date"]
                    # Parse date and check if it's a weekday (Monday=0, Sunday=6)
                    date_obj = datetime.strptime(holiday_date, "%Y-%m-%d")
                    if date_obj.weekday() >= 5:  # Skip weekends (Saturday=5, Sunday=6)
                        continue

                    if counties is not None:
                        # Check if state is included in counties (API returns AU-NSW format)
                        if any(
                            f"AU-{state.upper()}" == county.upper()
                            for county in counties
                        ):
                            holiday_dates.append(holiday_date)
                    else:
                        # Assume it's a valid holiday for all states
                        holiday_dates.append(holiday_date)
            else:
                print(f"Failed to retrieve holidays for {year}: {response.status_code}")
        except Exception as e:
            print(f"Error fetching holidays for {year}: {e}")
    return holiday_dates


# Fetch holidays for relevant years (current year and previous/next year)
current_year = datetime.now().year
holiday_dates = get_public_holidays([current_year - 1, current_year, current_year + 1])
print(f"Holidays for {holiday_dates}")

github_repos = [
    "InfoTrackGlobal/ContractReview",
    "InfoTrackGlobal/DocumentTransformationService",
    "InfoTrackGlobal/InfoTrack.Platform.Core.DocumentExtraction",
    "InfoTrackGlobal/InfoTrack.Platform.Core.DocumentClassification",
    "InfoTrackGlobal/SmartContracts",
    "InfoTrackGlobal/QldSellerDisclosure"
]
issue_regex = r"(?i)(?<=\()(?:wc|scn|sx|cr)-\d+"
default_time_spent = "6h 30m"
admin_ticket = "CR-338"
admin_time_spent = "1h"
JIRA_DATE_FORMAT = "%Y-%m-%dT%H:%M:%S.%f%z"
GITHUB_DATE_FORMAT = "%Y-%m-%dT%H:%M:%SZ"


def get_github_commits(repo, token):
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json",
    }
    commits_endpoint = f"https://api.github.com/repos/{repo}/commits"
    params = {"author": github_author, "per_page": 100}
    response = requests.get(
        commits_endpoint, headers=headers, params=params, timeout=10
    )
    if response.status_code == 200:
        commits_by_date = {}
        for commit in response.json():
            commit_date = datetime.strptime(
                commit["commit"]["author"]["date"], GITHUB_DATE_FORMAT
            ).strftime("%Y-%m-%d")
            issue_key_match = re.search(issue_regex, commit["commit"]["message"])
            issue_key = issue_key_match.group(0) if issue_key_match else ""
            if not issue_key:
                # skip this commit and move to the next one
                continue
            if commit_date not in commits_by_date:
                commits_by_date[commit_date] = {
                    "message": issue_key,
                    "date": commit["commit"]["author"]["date"],
                }
            else:
                # update to the earliest commit of the day
                existing_commit_date = commits_by_date[commit_date]["date"]
                if commit["commit"]["author"]["date"] < existing_commit_date:
                    commits_by_date[commit_date] = {
                        "message": issue_key,
                        "date": commit["commit"]["author"]["date"],
                    }
        return list(commits_by_date.values())
    else:
        print(f"Failed to retrieve commits: {response.status_code}")
        return []


def get_previous_commit(commits, target_date):
    target_date = target_date.replace(tzinfo=None)
    past_commits = [
        commit
        for commit in commits
        if datetime.strptime(commit["date"], GITHUB_DATE_FORMAT) <= target_date
    ]

    if not past_commits:
        return None
    closest_commit = min(
        past_commits,
        key=lambda commit: abs(
            target_date - datetime.strptime(commit["date"], GITHUB_DATE_FORMAT)
        ),
    )
    return closest_commit


def get_next_commit(commits, target_date):
    target_date = target_date.replace(tzinfo=None)
    past_commits = [
        commit
        for commit in commits
        if datetime.strptime(commit["date"], GITHUB_DATE_FORMAT) >= target_date
    ]

    if not past_commits:
        return None
    closest_commit = min(
        past_commits,
        key=lambda commit: abs(
            target_date - datetime.strptime(commit["date"], GITHUB_DATE_FORMAT)
        ),
    )
    return closest_commit


def get_jira_issue_details(issue_key):
    issue_endpoint = f"{jira_url}/issue/{issue_key}"
    response = requests.get(
        issue_endpoint, auth=HTTPBasicAuth(jira_username, jira_token), timeout=10
    )
    if response.status_code == 200:
        return response.json()
    else:
        print(
            f"Failed to retrieve issue details for {issue_key}: {response.status_code}"
        )
        return None


def get_top_parent_issue_key(issue_key):
    issue_details = get_jira_issue_details(issue_key)
    while (
        issue_details
        and "fields" in issue_details
        and "parent" in issue_details["fields"]
    ):
        parent_key = issue_details["fields"]["parent"]["key"]
        issue_details = get_jira_issue_details(parent_key)
    if issue_details:
        return issue_details["key"]


def add_worklog_to_issue(
    issue_key,
    time_spent,
    started,
):
    worklog_endpoint = f"{jira_url}/issue/{issue_key}/worklog"
    headers = {"Content-Type": "application/json"}
    payload = {"timeSpent": time_spent, "started": started}
    response = requests.post(
        worklog_endpoint,
        headers=headers,
        auth=HTTPBasicAuth(jira_username, jira_token),
        data=json.dumps(payload),
        timeout=10,
    )
    if response.status_code == 201:
        date_only = started.split("T")[0]
        print(f"Added worklog to issue {issue_key} for date {date_only}")
        return response.json()
    else:
        print(f"Failed to add worklog to issue {issue_key}: {response.status_code}")
        return None


search_endpoint = f"{jira_url}/search/jql"
params = {
    "jql": "worklogAuthor=currentUser() AND created >= -365d",
    "fields": "key",
}
search_response = requests.get(
    search_endpoint,
    params=params,
    auth=HTTPBasicAuth(jira_username, jira_token),
    timeout=10,
)

# get existing worklogs for user to determine when to start adding new worklogs
if search_response.status_code == 200:
    print(f"search response: {search_response.json()}")
    issues = search_response.json().get("issues", [])
    print(f"issues response: {issues}")
    worklogs = []
    issue_keys = set()
    for issue in issues:
        issue_key = issue.get("key")
        issue_keys.add(issue_key)

    # make a Jira API call for each unique issue key to get the worklogs
    for issue_key in issue_keys:
        worklog_endpoint = f"{jira_url}/issue/{issue_key}/worklog"
        worklog_response = requests.get(
            worklog_endpoint, auth=HTTPBasicAuth(jira_username, jira_token), timeout=10
        )
        if worklog_response.status_code == 200:
            issue_worklogs = worklog_response.json().get("worklogs", [])
            for worklog in issue_worklogs:
                if worklog.get("author", {}).get("emailAddress") == jira_username:
                    worklogs.append(
                        {"issueKey": issue_key, "started": worklog.get("started")}
                    )

    if worklogs:
        latest_worklog = max(worklogs, key=lambda x: x["started"])
        latest_started_date = datetime.strptime(
            latest_worklog["started"], "%Y-%m-%dT%H:%M:%S.%f%z"
        )

        # start looping from the next workday after the last recorded worklog
        current_date = latest_started_date + timedelta(days=1)
        print("start date", current_date)
        end_date = datetime.now(latest_started_date.tzinfo)
        print("end date", end_date)

        # Fetch commits from all repositories
        all_commits = []
        for repo in github_repos:
            print(f"Fetching commits from {repo}...")
            repo_commits = get_github_commits(repo, github_token)
            if repo_commits:
                all_commits.extend(repo_commits)

        commits = all_commits
        if commits:
            while current_date.date() <= end_date.date():
                # Monday to Friday are considered workdays
                if current_date.weekday() < 5:
                    current_date_formatted = current_date.strftime("%Y-%m-%d")
                    print(f"Processing workday: {current_date_formatted}")
                    is_public_holiday = current_date_formatted in holiday_dates
                    is_personal_leave = current_date_formatted in excluded_dates
                    if not is_public_holiday and not is_personal_leave:
                        previous_commit = get_previous_commit(commits, current_date)
                        next_commit = get_next_commit(commits, current_date)
                        if next_commit:
                            commit_ticket = next_commit["message"]
                            top_parent_issue_key = get_top_parent_issue_key(
                                commit_ticket
                            )
                            print(
                                f"  → Ticket: {commit_ticket} | Epic: {top_parent_issue_key} | Time: {default_time_spent}"
                            )
                            add_worklog_to_issue(
                                top_parent_issue_key,
                                default_time_spent,
                                current_date.strftime(JIRA_DATE_FORMAT),
                            )
                            # Add admin time
                            add_worklog_to_issue(
                                admin_ticket,
                                admin_time_spent,
                                current_date.strftime(JIRA_DATE_FORMAT),
                            )
                        elif previous_commit:
                            commit_ticket = previous_commit["message"]
                            top_parent_issue_key = get_top_parent_issue_key(
                                commit_ticket
                            )
                            print(
                                f"  → Ticket: {commit_ticket} | Epic: {top_parent_issue_key} | Time: {default_time_spent}"
                            )
                            add_worklog_to_issue(
                                top_parent_issue_key,
                                default_time_spent,
                                current_date.strftime(JIRA_DATE_FORMAT),
                            )
                            # Add admin time
                            add_worklog_to_issue(
                                admin_ticket,
                                admin_time_spent,
                                current_date.strftime(JIRA_DATE_FORMAT),
                            )
                        else:
                            print(
                                f"No commits found for {current_date.strftime('%Y-%m-%d')} or earlier."
                            )
                    elif is_public_holiday and is_personal_leave:
                        print(
                            f"Skipping date {current_date_formatted}: public holiday + personal leave"
                        )
                    elif is_public_holiday:
                        print(
                            f"Skipping date {current_date_formatted}: public holiday"
                        )
                    else:
                        print(
                            f"Skipping date {current_date_formatted}: personal leave"
                        )

                current_date += timedelta(days=1)
        else:
            print("No commits found.")

else:
    print(f"Failed to retrieve existing worklogs: {search_response.status_code}")

print("Timesheet script task completed.")
