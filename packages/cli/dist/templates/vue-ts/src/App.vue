<script setup lang="ts">
import type { UIXRecord } from '@dotuix/types';
import { onMounted, ref } from 'vue';

const items = ref<UIXRecord[]>([]);

async function load() {
  items.value = await uix.state.find({
    type: 'item',
    orderBy: { field: 'created_at', direction: 'desc' },
  });
}

async function addItem() {
  await uix.state.insert({
    type: 'item',
    body: JSON.stringify({ label: `Item ${Date.now()}` }),
  });
  await load();
}

async function deleteItem(id: string) {
  await uix.state.delete(id);
  await load();
}

onMounted(load);
</script>

<template>
  <div class="container">
    <h1>__NAME__</h1>

    <button @click="addItem">Add item</button>

    <p v-if="items.length === 0" class="muted">
      No items yet. Click the button to add one.
    </p>
    <ul v-else class="item-list">
      <li v-for="item in items" :key="item.id" class="item-card">
        <span>{{ JSON.parse(item.body as string).label }}</span>
        <button class="delete-btn" @click="deleteItem(item.id)">×</button>
      </li>
    </ul>
  </div>
</template>
