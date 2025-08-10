// Test file to verify environment variables are properly set in deployment
Deno.serve(() => {
  const testVar = Deno.env.get("TEST_VAR") || "not set";
  const apiUrl = Deno.env.get("API_URL") || "not set";
  const debug = Deno.env.get("DEBUG") || "not set";
  
  const response = {
    message: "Environment variables test",
    env: {
      TEST_VAR: testVar,
      API_URL: apiUrl,
      DEBUG: debug,
    },
    timestamp: new Date().toISOString(),
  };

  return new Response(JSON.stringify(response, null, 2), {
    headers: { "content-type": "application/json" },
  });
});