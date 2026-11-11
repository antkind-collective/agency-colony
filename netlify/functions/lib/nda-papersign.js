// The network half of NDAs: make the Papersign draft from the mutual NDA
// template once an NDA has its other side's details. Shared by nda-action
// (we typed them) and nda-intake (they used the link). Never throws: a failed
// draft is recorded on the row (draft_error) and can be retried from Colony.
const { call } = require('./papersign-client');
const { ndaVariables, mapNdaVariables, ndaSigners, ndaFileBase } = require('./nda');

async function ndaConfig(admin) {
  const { data } = await admin.from('app_config').select('key, value').in('key', ['nda_papersign', 'nda_live']);
  const map = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
  return { papersign: map.nda_papersign || {}, live: map.nda_live === true };
}

async function createNdaDraft(admin, nda) {
  if (nda.papersign_document_id) return { draftId: nda.papersign_document_id };
  const { papersign } = await ndaConfig(admin);
  try {
    if (!papersign.template_id || !papersign.folder_id) throw new Error('The NDA template is not configured.');
    // Re-read the template every time: keys can change when it is edited.
    const tpl = await call('GET', `/papersign/documents/${encodeURIComponent(papersign.template_id)}`);
    const doc = tpl.document || tpl;
    const variables = mapNdaVariables(ndaVariables(nda), doc.variables);
    const signers = ndaSigners(doc.signers, nda);
    const r = await call('POST', `/papersign/documents/${encodeURIComponent(papersign.template_id)}/create-draft`, {
      // By folder id: the NDAs folder, never Consultants/Employees (whose
      // completion webhook would read an NDA as a hire's agreement).
      copy: { name: ndaFileBase(nda), folder_id: Number(papersign.folder_id) },
      signers,
      variables
    });
    const draft = r.document || r;
    if (!draft?.id) throw new Error('Papersign returned no document id.');
    // Read it back: every value must have landed.
    const back = await call('GET', `/papersign/documents/${encodeURIComponent(draft.id)}`).catch(() => null);
    const got = new Map(((back?.document || back || {}).variables || []).map((v) => [String(v.key), String(v.value ?? '')]));
    const wrong = variables.filter((v) => got.size && got.get(String(v.key)) !== String(v.value));
    const now = new Date().toISOString();
    await admin.from('ndas').update({
      papersign_document_id: String(draft.id),
      draft_error: wrong.length ? `Papersign changed ${wrong.length} value(s); check the preview.` : null,
      updated_at: now
    }).eq('id', nda.id);
    return { draftId: String(draft.id) };
  } catch (e) {
    await admin.from('ndas').update({ draft_error: String(e.message).slice(0, 300), updated_at: new Date().toISOString() }).eq('id', nda.id);
    return { error: e.message };
  }
}

module.exports = { createNdaDraft, ndaConfig };
