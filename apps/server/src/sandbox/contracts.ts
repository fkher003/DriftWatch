export const checkout = {
  type: "object",
  required: ["service", "items"],
  properties: {
    service: { const: "checkout" },
    items: { type: "integer", minimum: 0 },
  },
};
export const orders = {
  type: "object",
  required: ["orders"],
  properties: {
    orders: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "quantity"],
        properties: {
          id: { type: "string" },
          quantity: { type: "integer", minimum: 0 },
        },
      },
    },
  },
};
