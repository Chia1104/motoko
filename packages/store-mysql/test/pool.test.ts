// The store takes a pool that sends multi-statement queries, and refuses any other before it sends anything. No
// database: a mysql2 pool connects at its first query.

import mysql from "mysql2";
import mysqlPromise from "mysql2/promise";
import { describe, expect, it } from "vite-plus/test";

import { createMysqlStore } from "../src/index.ts";

const uri = "mysql://nobody@127.0.0.1:1/none";

describe("the store's pool", () => {
  it("must allow multiple statements", async () => {
    const plain = mysqlPromise.createPool({ uri });
    const off = mysqlPromise.createPool({ uri, multipleStatements: false });
    try {
      for (const pool of [plain, off]) {
        expect(() => createMysqlStore(pool)).toThrow(TypeError);
        expect(() => createMysqlStore(pool)).toThrow("multipleStatements: true");
      }
    } finally {
      await Promise.all([plain.end(), off.end()]);
    }
  });

  it("may say so in its options, its URL, or as a callback pool's promise()", async () => {
    const pools = [
      mysqlPromise.createPool({ uri, multipleStatements: true }),
      mysqlPromise.createPool({ uri: `${uri}?multipleStatements=true` }),
      mysql.createPool({ uri, multipleStatements: true }).promise(),
    ];
    try {
      for (const pool of pools) expect(createMysqlStore(pool).lease).toBeTypeOf("function");
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  });
});
