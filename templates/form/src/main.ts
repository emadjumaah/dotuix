/// <reference types="@dotuix/types" />
/**
 * main.ts — form document entry point
 *
 * state.mode is "file" → all records are stored inside the .uix archive
 * itself. Opening the file opens the form. Saving the file saves the data.
 * Sharing the file shares the filled-in content.
 */

const RECORD_ID = 'form:__SLUG__:data';

const app = document.getElementById('app')!;

app.innerHTML = `
  <header>
    <h1>__NAME__</h1>
    <button id="print-btn" title="Print">🖨 Print</button>
  </header>
  <form id="form-el" autocomplete="off">
    <label>
      <span>Full name</span>
      <input id="field-name" type="text" placeholder="Jane Smith" />
    </label>
    <label>
      <span>Email</span>
      <input id="field-email" type="email" placeholder="jane@example.com" />
    </label>
    <label>
      <span>Notes</span>
      <textarea id="field-notes" rows="5" placeholder="Enter details…"></textarea>
    </label>
    <div class="actions">
      <button type="submit" id="save-btn">Save</button>
      <span id="saved-msg" class="saved-msg" aria-live="polite"></span>
    </div>
  </form>
`;

const fieldName = document.getElementById('field-name') as HTMLInputElement;
const fieldEmail = document.getElementById('field-email') as HTMLInputElement;
const fieldNotes = document.getElementById('field-notes') as HTMLTextAreaElement;
const saveBtn = document.getElementById('save-btn')!;
const savedMsg = document.getElementById('saved-msg')!;
const printBtn = document.getElementById('print-btn')!;

interface FormData {
  name: string;
  email: string;
  notes: string;
}

async function load() {
  const rec = await uix.state.get(RECORD_ID);
  if (!rec) return;
  const data = JSON.parse(rec.body as string) as FormData;
  fieldName.value = data.name ?? '';
  fieldEmail.value = data.email ?? '';
  fieldNotes.value = data.notes ?? '';
}

async function save() {
  const data: FormData = {
    name: fieldName.value,
    email: fieldEmail.value,
    notes: fieldNotes.value,
  };
  await uix.state.upsert({ id: RECORD_ID, type: 'form-data', body: JSON.stringify(data) });
  savedMsg.textContent = 'Saved ✓';
  setTimeout(() => {
    savedMsg.textContent = '';
  }, 2000);
}

document.getElementById('form-el')?.addEventListener('submit', (e) => {
  e.preventDefault();
  save().catch(console.error);
});

printBtn.addEventListener('click', () => uix.print());

load().catch(console.error);
