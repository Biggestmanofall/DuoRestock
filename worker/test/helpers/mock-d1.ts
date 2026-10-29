/**
 * In-memory contract mock for the D1 interface used by src/state.ts.
 *
 * It recognizes exactly the SQL statements state.ts issues (fails loudly on
 * anything else), so the unit tests exercise state.ts's behavior end-to-end
 * without a database. Real D1 semantics are verified later via `wrangler dev`
 * (miniflare) and after deployment.
 */

import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";

export interface MockStateRow {
  storeNumber: string;
  partNumber: string;
  available: 0 | 1 | 2;
  updatedAt: number;
}

interface MockFailureRow {
  consecutive: number;
  nextAttemptAt: number;
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

export class MockD1 {
  readonly states = new Map<string, MockStateRow>();
  readonly alerts = new Map<string, number>();
  failure: MockFailureRow | null = null;
  readonly executedSql: string[] = [];

  prepare(sql: string): D1PreparedStatement {
    const self = this;
    let params: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        params = values;
        return statement;
      },
      async first<T = unknown>(): Promise<T | null> {
        self.executedSql.push(normalize(sql));
        return self.#executeFirst(normalize(sql)) as T | null;
      },
      async all<T = unknown>(): Promise<D1Result<T>> {
        self.executedSql.push(normalize(sql));
        return self.#executeAll(normalize(sql)) as unknown as D1Result<T>;
      },
      async run<T = unknown>(): Promise<D1Result<T>> {
        self.executedSql.push(normalize(sql));
        self.#executeRun(normalize(sql), params);
        return { results: [], success: true, meta: {} } as unknown as D1Result<T>;
      },
    };
    return statement as unknown as D1PreparedStatement;
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
    for (const statement of statements) {
      await statement.run<Record<string, unknown>>();
    }
    return [];
  }

  async exec(_query: string): Promise<D1Result<unknown>> {
    throw new Error("MockD1.exec is not implemented");
  }

  // ------------------------------------------------------------- inspection

  stateValue(storeNumber: string, partNumber: string): 0 | 1 | 2 | undefined {
    return this.states.get(`${storeNumber}:${partNumber}`)?.available;
  }

  lastAlertAt(storeNumber: string, partNumber: string): number | undefined {
    return this.alerts.get(`${storeNumber}:${partNumber}`);
  }

  // ------------------------------------------------------------- execution

  #executeFirst(sql: string): unknown {
    if (sql === "select consecutive_failures, next_attempt_at from failures where id = 1") {
      return this.failure
        ? { consecutive_failures: this.failure.consecutive, next_attempt_at: this.failure.nextAttemptAt }
        : null;
    }
    throw new Error(`MockD1: unhandled SQL for first(): ${sql}`);
  }

  #executeAll(sql: string): { results: unknown[]; success: boolean } {
    if (sql === "select store_number, part_number, available from inventory_state") {
      return {
        success: true,
        results: [...this.states.values()].map((row) => ({
          store_number: row.storeNumber,
          part_number: row.partNumber,
          available: row.available,
        })),
      };
    }
    if (sql === "select store_number, part_number, alerted_at from alerts") {
      return {
        success: true,
        results: [...this.alerts.entries()].map(([key, alertedAt]) => {
          const [store_number, part_number] = key.split(":");
          return { store_number, part_number, alerted_at: alertedAt };
        }),
      };
    }
    throw new Error(`MockD1: unhandled SQL for all(): ${sql}`);
  }

  #executeRun(sql: string, params: unknown[]): void {
    if (sql.startsWith("insert into inventory_state")) {
      const [storeNumber, partNumber, available, updatedAt] = params as [string, string, 0 | 1 | 2, number];
      this.states.set(`${storeNumber}:${partNumber}`, { storeNumber, partNumber, available, updatedAt });
      return;
    }
    if (sql.startsWith("insert into alerts")) {
      const [storeNumber, partNumber, alertedAt] = params as [string, string, number];
      this.alerts.set(`${storeNumber}:${partNumber}`, alertedAt);
      return;
    }
    if (sql.startsWith("insert into failures")) {
      const [consecutive, nextAttemptAt] = params as [number, number];
      this.failure = { consecutive, nextAttemptAt };
      return;
    }
    if (sql === "delete from failures where id = 1") {
      this.failure = null;
      return;
    }
    throw new Error(`MockD1: unhandled SQL for run(): ${sql}`);
  }
}
