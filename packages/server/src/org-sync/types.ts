/**
 * The organisation import contract (INV-1288).
 *
 * An *organisation import* brings an outside organisation into Involute: the
 * groups it has become teams, and the people in them become members. It is a
 * separate thing from sign-in — sign-in asks "who is this person?", the
 * import asks "who is in the organisation and where do they sit?" — and it is
 * separate on purpose.
 *
 * The contract here is **source-neutral**. It says what a source must be able
 * to say, not how any particular source says it: a group has an id at the
 * source and a key in Involute; a person has an id at the source, an address,
 * and a name. How a source's own shape is walked into that — a DingTalk
 * department tree, a Google group, a flat roster file — is the source's
 * business, and it lives in that source's own module.
 *
 * The engine that reads this contract (`engine.ts`) knows nothing about any
 * source in particular. That is what keeps the import independent.
 */

import type { TeamMembershipRole } from '@prisma/client';

/** A person, as the outside organisation describes them. */
export interface OrganizationPerson {
  /**
   * The source's stable id for this person — DingTalk `unionId`, for example.
   * It is what the identity is recorded under, so it must not change when the
   * person moves.
   *
   * `null` when the source has no stable id for this person. The person can
   * still be a member, but no identity is recorded, so they cannot sign in
   * through this source — the import reports them rather than inventing an
   * id that would never match.
   */
  externalId: string | null;
  /**
   * The person's address, if the source has one. Involute keys people by
   * address (docs/permissions.md §1), so a person without one cannot be
   * admitted, and is reported rather than dropped in silence.
   */
  email: string | null;
  name: string;
  avatarUrl?: string | null;
}

/** A group in the outside organisation, and the team it becomes. */
export interface OrganizationGroup {
  /** The source's id for this group — a DingTalk `deptId`, for example. */
  externalId: string;
  /**
   * The Involute team key this group becomes, e.g. `CORE`. It also becomes
   * the identifier prefix (`CORE-12`), so it must be short, upper-case and
   * unique in the workspace.
   */
  teamKey: string;
  /** The team name; the source's own name is used when this is absent. */
  name?: string;
  /** The membership role people get. Defaults to EDITOR. */
  role?: TeamMembershipRole;
  /** The people in this group. */
  people: readonly OrganizationPerson[];
}

/** One outside organisation, ready to be written into Involute. */
export interface OrganizationSyncInput {
  /**
   * Which source this came from. It is recorded on the identity and on the
   * team binding, so two sources can never claim the same person or the same
   * team by accident.
   */
  provider: string;
  groups: readonly OrganizationGroup[];
}
