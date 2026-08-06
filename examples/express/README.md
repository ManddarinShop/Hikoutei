# Express example

```sh
npm install
npm start
```

- `createTypedSheets` opens the local SQLite authority once at startup.
- A middleware forks a request-local `em` per request.
- CRUD routes persist through `flush()` (local commit; the Sheets projection,
  when wired service-side, delivers asynchronously afterwards).
- `SIGINT`/`SIGTERM` close the runtime gracefully.
