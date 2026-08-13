<script setup>
import { ref } from "vue";

// Interactive demo: models the Hikoutei write path
// (commit to SQLite -> durable outbox -> async Sheets projection).
const name = ref("");
const email = ref("");
const status = ref("connected");
const rows = ref([
  { id: "u1", name: "Ada Lovelace", email: "ada@example.com" },
  { id: "u2", name: "Grace Hopper", email: "grace@example.com" },
]);

function addRow() {
  if (!name.value.trim() || !email.value.trim()) return;
  status.value = "syncing…";
  setTimeout(() => {
    rows.value.push({
      id: `u${rows.value.length + 1}`,
      name: name.value.trim(),
      email: email.value.trim(),
    });
    name.value = "";
    email.value = "";
    status.value = "synced";
  }, 400);
}
</script>

<template>
  <div class="sync-demo">
    <div class="sync-demo__bar">
      <span class="sync-demo__dot" />
      <span class="sync-demo__title">hikoutei · live sync demo</span>
      <span class="sync-demo__status">{{ status }}</span>
    </div>
    <div class="sync-demo__body">
      <form class="sync-demo__form" @submit.prevent="addRow">
        <input v-model="name" placeholder="Name" aria-label="Name" />
        <input v-model="email" placeholder="Email" aria-label="Email" />
        <button type="submit">Add row →</button>
      </form>
      <div class="sync-demo__table-wrap">
        <table class="sync-demo__table">
          <thead>
            <tr>
              <th>id</th>
              <th>name</th>
              <th>email</th>
              <th>projection</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id">
              <td class="sync-demo__mono">{{ row.id }}</td>
              <td>{{ row.name }}</td>
              <td>{{ row.email }}</td>
              <td><span class="sync-demo__synced">✓ synced</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <div class="sync-demo__foot">
      committed to SQLite → durable outbox → projected to Sheets
    </div>
  </div>
</template>
