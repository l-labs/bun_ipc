#!/usr/bin/env bun
/**
 * Integration tests demonstrating real-world usage patterns
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  LConnection,
  I, F, S, D, Z, B,
  vI, vF, vS, vZ,
} from "../src/index";

const PORT = parseInt(process.env.L_TEST_PORT || "5001");

let serverAvailable = false;
try {
  const testConn = LConnection.connect("localhost", PORT);
  testConn.close();
  serverAvailable = true;
} catch (e) {
  console.log(`L server not on port ${PORT}, integration tests skipped`);
}

describe.skipIf(!serverAvailable)("L Integration Tests", () => {
  let conn: LConnection;
  
  beforeAll(() => {
    conn = LConnection.connect("localhost", PORT);
  });
  
  afterAll(() => {
    // Clean up test tables
    try {
      conn.execute("delete trades from `.");
      conn.execute("delete quotes from `.");
      conn.execute("delete products from `.");
    } catch (e) {
      // Tables might not exist
    }
    conn.close();
  });

  describe("Time Series Data", () => {
    test("should create and query a trades table", async () => {
      
      // Create trades table
      conn.execute(
        "trades: ([] time:`datetime$(); sym:`symbol$(); " +
          "price:`float$(); size:`int$())",
      );
      
      // Insert trades using type constructors
      const now = new Date();
      for (let i = 0; i < 5; i++) {
        const trade = [
          Z(new Date(now.getTime() + i * 1000)),
          S(["AAPL", "GOOGL", "MSFT"][i % 3]),
          F(100 + Math.random() * 10),
          I(100 * (1 + Math.floor(Math.random() * 10)))
        ];
        conn.execute("insert", "trades", trade);
      }
      
      // Wait for inserts to sync
      await new Promise(r => setTimeout(r, 100));
      
      // Query the data
      const count = conn.execute("count trades");
      expect(count).toBe(5);
      
      // Calculate VWAP by symbol
      const vwap = conn.execute(
        "select vwap: sum[price*size]%sum[size] by sym from trades",
      );
      expect(vwap.sym).toBeDefined();
      expect(vwap.vwap).toBeDefined();
      
      // Get latest price by symbol
      const latest = conn.execute("select last price by sym from trades");
      expect(Object.keys(latest).length).toBeGreaterThan(0);
    });

    test("should handle bulk insert with vectors", async () => {
      
      // Create quotes table
      conn.execute(
        "quotes: ([] time:`datetime$(); sym:`symbol$(); bid:`float$(); " +
          "ask:`float$(); bsize:`int$(); asize:`int$())",
      );
      
      // Bulk insert using vector constructors
      const times = [];
      const syms = [];
      const bids = [];
      const asks = [];
      const bsizes = [];
      const asizes = [];
      
      const baseTime = new Date();
      const symbols = ["AAPL", "GOOGL", "MSFT", "AMZN"];
      
      for (let i = 0; i < 20; i++) {
        times.push(new Date(baseTime.getTime() + i * 100));
        syms.push(symbols[i % symbols.length]);
        const mid = 100 + (i % symbols.length) * 50 + Math.random() * 5;
        bids.push(mid - 0.01);
        asks.push(mid + 0.01);
        bsizes.push(100 + Math.floor(Math.random() * 900));
        asizes.push(100 + Math.floor(Math.random() * 900));
      }
      
      // Create table from vectors
      conn.set("quoteData", {
        time: vZ(...times),
        sym: vS(...syms),
        bid: vF(...bids),
        ask: vF(...asks),
        bsize: vI(...bsizes),
        asize: vI(...asizes)
      });
      
      // Insert into quotes table
      conn.execute("`quotes insert flip quoteData");
      
      await new Promise(r => setTimeout(r, 100));
      
      // Verify data
      const count = conn.execute("count quotes");
      expect(count).toBe(20);
      
      // Calculate spreads
      const spreads = conn.execute(
        "select time, sym, spread:ask-bid from quotes",
      ) as any[];
      expect(
        spreads.every((row: any) => Math.abs(row.spread - 0.02) < 0.001),
      ).toBe(true);
    });
  });

  describe("Business Data Processing", () => {
    test("should handle product catalog with mixed types", async () => {
      
      // Create products table
      conn.execute(
        "products: ([] id:`int$(); name:`symbol$(); category:`symbol$(); " +
          "price:`float$(); inStock:`boolean$(); lastUpdated:`date$())",
      );
      
      // Insert products
      const products = [
        [I(1001), S("laptop"), S("electronics"), F(999.99), B(true),
          D(new Date())],
        [I(1002), S("mouse"), S("electronics"), F(29.99), B(true),
          D(new Date())],
        [I(1003), S("desk"), S("furniture"), F(299.99), B(false),
          D(new Date())],
        [I(1004), S("chair"), S("furniture"), F(199.99), B(true),
          D(new Date())],
        [I(1005), S("monitor"), S("electronics"), F(399.99), B(true),
          D(new Date())],
      ];
      
      for (const product of products) {
        conn.execute("insert", "products", product);
      }
      
      await new Promise(r => setTimeout(r, 100));
      
      // Query by category
      const electronics = conn.execute(
        "select from products where category=`electronics",
      ) as any[];
      expect(electronics.length).toBe(3);
      
      // Get in-stock items
      const inStock = conn.execute(
        "select from products where inStock",
      ) as any[];
      expect(inStock.length).toBe(4);
      
      // Calculate category totals
      const totals = conn.execute(
        "select count i, avgPrice: avg price by category from products",
      );
      expect(totals.category).toContain("electronics");
      expect(totals.category).toContain("furniture");
    });
  });

  describe("Advanced Queries", () => {
    test("should handle complex joins and aggregations", async () => {
      
      // Skip if tables don't exist
      try {
        conn.execute("count trades");
        conn.execute("count quotes");
      } catch (e) {
        return;
      }
      
      // Time-weighted average price
      const twap = conn.execute(
        "select twap: time wavg price, high: max price, " +
          "low: min price, volume: sum size by sym from trades",
      );
      
      expect(twap.sym).toBeDefined();
      expect(twap.twap).toBeDefined();
      expect(twap.high).toBeDefined();
      expect(twap.low).toBeDefined();
      
      // Join trades and quotes (asof join)
      const joined = conn.execute("aj[`sym`time; trades; quotes]") as any[];
      
      expect(joined).toBeDefined();
      expect(joined.length).toBeGreaterThan(0);
      expect(joined[0].price).toBeDefined();
      expect(joined[0].bid).toBeDefined();
      expect(joined[0].ask).toBeDefined();
    });
  });

  describe("Error Handling", () => {
    test("should handle and recover from errors", () => {
      
      // Type error
      expect(() => conn.execute("1 + `symbol")).toThrow();
      
      // Undefined variable
      expect(() => conn.execute("undefined_var")).toThrow();
      
      // Invalid table
      expect(() => conn.execute("select from nonexistent")).toThrow();
      
      // Connection should still work
      expect(conn.execute("1+1")).toBe(2);
    });
  });

  describe("Memory Management", () => {
    test("should handle rapid sequential operations", () => {
      
      // Rapid fire calculations
      for (let i = 0; i < 100; i++) {
        const result = conn.execute("sum", vI(1, 2, 3, 4, 5));
        expect(result).toBe(15);
      }
      
      // Large array operations
      const bigArray = Array.from({ length: 1000 }, (_, i) => i);
      const sum = conn.execute("sum", vI(...bigArray));
      expect(sum).toBe(499500);
      
      // Many small operations
      const results = [];
      for (let i = 0; i < 50; i++) {
        results.push(conn.execute(`${i}*${i}`));
      }
      expect(results[10]).toBe(100);
      expect(results[20]).toBe(400);
    });
  });
});
