// Quickstart: connect, query, and print a table.
// Start a server first:  l -p 5001
// Run with:              bun run examples/quickstart.ts
import { LConnection, I, vF, vI, vS } from "../src/index";

const port = parseInt(process.env.L_TEST_PORT || "5001");
const conn = LConnection.connect("localhost", port);

console.log(conn.execute("1+1"));                                               // 2
console.log(conn.execute("til 10"));                                            // [0, 1, ..., 9]

// Build a table server-side and query it
conn.execute("trade:([]sym:`IBM`MSFT`AAPL;price:120.5 340.2 175.8)");
console.log(conn.execute("select from trade where price > 200"));
// [{ sym: "MSFT", price: 340.2 }]

// Pass values from Bun using generators
console.log(conn.execute("sum", vI(1, 2, 3, 4, 5)));                            // 15
console.log(conn.execute("{x+y}", I(10), I(32)));                               // 42

// Build a table from Bun-side vectors
conn.set("t", {
  sym: vS("IBM", "MSFT", "AAPL"),
  price: vF(120.5, 340.2, 175.8),
  qty: vI(100, 200, 300),
});
conn.execute("t: flip t");
console.table(conn.execute("select sym, price from t"));

conn.close();
