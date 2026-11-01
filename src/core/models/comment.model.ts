/** A comment on an issue, independent of any provider's wire format. */
export interface IComment {
  /** Stable identifier as returned by the provider. */
  readonly id: string;
  readonly author: string;
  readonly body: string;
  /** ISO 8601 creation timestamp. */
  readonly createdAt: string;
  /** Permalink to the comment, when the provider exposes one. */
  readonly url?: string;
}
