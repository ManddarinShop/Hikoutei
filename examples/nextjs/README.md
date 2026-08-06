# Next.js (App Router) example

```sh
npm install
npm run dev
```

- The runtime is a `globalThis` singleton, opened lazily by route handlers.
- A local SQLite file needs a long-lived Node process: use
  `output: "standalone"` in a container. Serverless Functions (read-only
  filesystem) cannot host Hikoutei.
