/**
 * A database dialect adapter. Adding a new engine means implementing this
 * interface and calling registerDialect() once — the backup/restore core never
 * needs to change.
 */
export interface Dialect {
  /** Stable identifier used in config.yaml (`dialect: postgres`). */
  readonly name: string;
  /** URL schemes this adapter accepts, e.g. ["mariadb://", "mysql://"]. */
  readonly urlSchemes: readonly string[];

  /** Stream a logical dump of `url` to `output`. Must not buffer in RAM. */
  dump(url: string, output: string): Promise<void>;

  /** Restore `input` (a plain SQL dump) into `url`. */
  restore(url: string, input: string): Promise<void>;
}
