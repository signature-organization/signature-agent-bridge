# Expose the bridge through a tunnel

[Security](../SECURITY.md) · [API](api.md)

The bridge remains bound to `127.0.0.1`. A tunnel provides the HTTPS edge; the bridge still authenticates every application request.

## Configure the public identity

For a public hostname such as `bridge.example.com`, stop the service and add the exact values to `config.json`:

```json
{
  "allowedHosts": ["localhost", "127.0.0.1", "bridge.example.com"],
  "allowedOrigins": ["https://bridge.example.com"]
}
```

Merge these settings into the existing file; do not replace the whole configuration. Restart the service.

Create a separate scoped client token under **Diagnostics → Client access**. Keep the owner token local.

## Cloudflare Tunnel

A named tunnel can route `bridge.example.com` to `http://127.0.0.1:8766`. For a short-lived test:

```sh
cloudflared tunnel --url http://127.0.0.1:8766
```

Add the actual assigned hostname and HTTPS origin to the bridge allowlists before using it. Follow [Cloudflare's local tunnel documentation](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) for current setup requirements. Access policies can provide an additional edge check; they do not replace bridge authentication.

## ngrok

```sh
ngrok http http://127.0.0.1:8766
```

Configure the assigned hostname and HTTPS origin in the allowlists. See [ngrok's HTTP endpoint documentation](https://ngrok.com/docs/http/).

## Streaming and verification

Preserve `Authorization` and `Last-Event-ID`. Disable proxy response buffering and use an idle timeout longer than the bridge's 15-second SSE heartbeat.

```sh
curl --fail-with-body "https://bridge.example.com/v1/status" \
  -H "Authorization: Bearer $BRIDGE_TOKEN"

curl -N "https://bridge.example.com/v1/events" \
  -H "Authorization: Bearer $BRIDGE_TOKEN"
```

A connection without a token must return 401. An unconfigured Host or Origin must return 403. Confirm that events arrive incrementally instead of being buffered until the response ends.

Do not put tokens in URLs. A remote token with an execution-capable profile can cause local actions with the OS user's privileges; provision it only for a trusted application.
