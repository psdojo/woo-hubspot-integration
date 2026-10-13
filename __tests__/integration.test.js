const { GenericContainer } = require("testcontainers");
const request = require("supertest");
const axios = require("axios");

describe("woocommerce to hubspot integration tests with testcontainers", () => {
  let wiremockContainer;
  let wiremockUrl;
  let app;

  jest.setTimeout(120000);

  beforeAll(async () => {
    wiremockContainer = await new GenericContainer("wiremock/wiremock:3.13.2")
      .withExposedPorts(8080)
      .start();

    const host = wiremockContainer.getHost();
    const port = wiremockContainer.getMappedPort(8080);
    wiremockUrl = `http://${host}:${port}`;

    process.env.HUBSPOT_BASE_URL = wiremockUrl;
    process.env.HUBSPOT_ACCESS_TOKEN = "test-token";

    jest.resetModules();
    app = require("../index");

    await axios.post(`${wiremockUrl}/__admin/mappings`, {
      request: { method: "POST", urlPath: "/crm/v3/objects/contacts/search" },
      response: {
        status: 200,
        jsonBody: { total: 0, results: [] },
        headers: { "Content-Type": "application/json" },
      },
    });

    await axios.post(`${wiremockUrl}/__admin/mappings`, {
      request: { method: "POST", urlPath: "/crm/v3/objects/contacts" },
      response: {
        status: 201,
        jsonBody: {
          id: "99999",
          properties: {
            email: "enterprise.client@test.com",
            firstname: "Jane",
            lastname: "Doe",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          archived: false,
        },
        headers: { "Content-Type": "application/json" },
      },
    });

    await axios.post(`${wiremockUrl}/__admin/mappings`, {
      request: { method: "POST", urlPath: "/crm/v3/objects/deals" },
      response: {
        status: 201,
        jsonBody: {
          id: "88888",
          properties: {
            dealname: "WooCommerce Order #101",
            amount: "150.00",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          archived: false,
        },
        headers: { "Content-Type": "application/json" },
      },
    });

    await axios.post(`${wiremockUrl}/__admin/mappings`, {
      request: {
        method: "PUT",
        urlPathPattern:
          "/crm/v4/objects/deals/[^/]+/associations/contacts/[^/]+",
      },
      response: {
        status: 201,
        jsonBody: {
          fromObjectType: "deal",
          fromObjectId: 88888,
          toObjectType: "contact",
          toObjectId: 99999,
          labels: [],
        },
        headers: { "Content-Type": "application/json" },
      },
    });
  });

  afterAll(async () => {
    if (wiremockContainer) {
      await wiremockContainer.stop();
    }
  });

  it("should process incoming woo order and pass integration against wiremock container", async () => {
    const mockOrder = {
      id: 101,
      total: "150.00",
      billing: {
        email: "enterprise.client@test.com",
        first_name: "Jane",
        last_name: "Doe",
        phone: "555-0199",
      },
    };

    const response = await request(app)
      .post("/webhook/woocommerce/order-created")
      .send(mockOrder);

    expect(response.statusCode).toEqual(200);
    expect(response.body.success).toBe(true);
    expect(response.body.message).toEqual("Order #101 synced successfully");
  });
});
