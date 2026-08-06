# NestJS example

```sh
npm install
npm start
```

- `HikouteiModule` opens the runtime once (module init) and closes it on
  shutdown (`OnModuleDestroy`).
- Services fork a fresh `em` per operation.
