// Northwind Lab: an endpoint only this script names (for katana's JavaScript parsing).
globalThis.loadOrders = function () {
  return fetch("/api/v1/orders").then(function (r) { return r.json(); });
};
