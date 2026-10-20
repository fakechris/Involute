/**
 * Redmine wire shapes.
 *
 * This Redmine is old: its REST API (`/api/*`) is switched off and only the
 * web controllers answer, so these are the shapes the web layer renders as
 * JSON (`/projects.json`, `/issues.json`, `/issues/<id>.json`).
 *
 * Redmine omits a field when it is empty, so most of these are optional.
 */

export interface RedmineProject {
  created_on?: string;
  description?: string;
  id: number;
  identifier: string;
  name: string;
  status?: number;
  updated_on?: string;
}

export interface RedmineNamedRef {
  id: number;
  name: string;
}

export interface RedmineUserRef extends RedmineNamedRef {
  /** Redmine's login. Present on `/users.json`, not on an issue's `author`. */
  login?: string;
  mail?: string;
}

export interface RedmineIssue {
  assigned_to?: RedmineUserRef | null;
  author?: RedmineUserRef;
  closed_on?: string;
  created_on: string;
  description?: string | null;
  done_ratio?: number;
  due_date?: string | null;
  estimated_hours?: number | null;
  id: number;
  priority: RedmineNamedRef;
  project: RedmineNamedRef;
  spent_hours?: number;
  start_date?: string | null;
  status: RedmineNamedRef;
  subject: string;
  tracker: RedmineNamedRef;
  updated_on: string;
}

export interface RedmineJournalDetail {
  new_value?: string | null;
  name?: string;
  old_value?: string | null;
  property?: string;
}

export interface RedmineJournal {
  created_on: string;
  details?: RedmineJournalDetail[];
  id: number;
  notes?: string;
  user?: RedmineUserRef;
}

export interface RedmineAttachment {
  author?: RedmineUserRef;
  content_type?: string;
  content_url?: string;
  description?: string;
  filesize?: number;
  filename?: string;
  id: number;
}

export interface RedmineRelation {
  delay?: number | null;
  id: number;
  issue_id: number;
  issue_to_id: number;
  relation_type: string;
}

export interface RedmineIssueDetail extends RedmineIssue {
  attachments?: RedmineAttachment[];
  journals?: RedmineJournal[];
  relations?: RedmineRelation[];
}

export interface RedmineUser {
  created_on?: string;
  firstname?: string;
  id: number;
  lastname?: string;
  last_login_on?: string;
  login?: string;
  mail?: string;
}

export interface RedmineTracker extends RedmineNamedRef {}

export interface RedmineIssueStatus extends RedmineNamedRef {
  is_closed?: boolean;
  is_default?: boolean;
}

/** `/projects.json` and `/issues.json` both wrap their list and count it. */
export interface RedmineListResponse<T> {
  total_count?: number;
  limit?: number;
  offset?: number;
  projects?: T[];
  issues?: T[];
  users?: T[];
  trackers?: T[];
  issue_statuses?: T[];
}
