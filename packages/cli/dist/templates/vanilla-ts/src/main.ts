/// <reference types="@dotuix/types" />
/**
 * main.ts — entry point for __NAME__
 *
 * `uix` is injected globally by the dotuix viewer (or the dev bridge mock).
 * Full type docs: https://github.com/dotuix/dotuix/tree/main/packages/types
 */

const app = document.getElementById('app')!;

app.innerHTML = `
  <h1>__NAME__</h1>
  <button id="add-btn">Add record</button>
  <div id="records"></div>
`;

const addBtn = document.getElementById('add-btn')!;
const list = document.getElementById('records')!;

async function render() {
  const records = await uix.state.find({
    type: 'item',
    orderBy: { field: 'created_at', direction: 'desc' },
  });
  list.innerHTML = records.length
    ? records.map((r) => `<div class="record-card">${r.id} — ${r.body}</div>`).join('')
    : `<p style="color:#666">No items yet. Click the button to add one.</p>`;
}

addBtn.addEventListener('click', async () => {
  await uix.state.insert({
    type: 'item',
    body: JSON.stringify({ label: `Item ${Date.now()}` }),
  });
  await render();
});

render().catch(console.error);
