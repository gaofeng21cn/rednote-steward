import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';

const LABELS = {
  original: ['原创声明', '声明原创', '我声明此内容为原创'],
  aiGenerated: ['内容由AI生成', '内容为AI生成', '包含AI生成内容', 'AI合成内容'],
};

function optionalBoolean(value, name) {
  if (value == null || value === '') return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new ArgumentError(`${name} must be true or false when supplied`);
}

/** Omitted declarations are never changed by the publisher. */
export function validateDeclarations(kwargs = {}) {
  const original = optionalBoolean(kwargs.original, 'original');
  const aiGenerated = optionalBoolean(kwargs['ai-declaration'], 'ai-declaration');
  return {
    ...(original == null ? {} : { original }),
    ...(aiGenerated == null ? {} : { aiGenerated }),
  };
}

/**
 * Conservative composer-only check. An exact visible label must identify one
 * native or accessible checkbox/switch. Buttons that open an unknown dialog
 * are deliberately not treated as an original/AI declaration control.
 */
export function declarationStateScript(key, wanted, click = false) {
  if (!Object.hasOwn(LABELS, key)) throw new ArgumentError('Unknown declaration field');
  return `((labels, wanted, click) => {
    const visible = el => Boolean(el && el.offsetParent !== null);
    const norm = value => String(value || '').replace(/\\s+/g, '').trim();
    const isControl = el => Boolean(el && (el.matches?.('input[type="checkbox"], [role="checkbox"], [role="switch"]')));
    const candidates = [];
    for (const label of Array.from(document.querySelectorAll('label, [role="checkbox"], [role="switch"]'))) {
      if (!visible(label) || !labels.includes(norm(label.innerText || label.textContent || label.getAttribute('aria-label')))) continue;
      const control = isControl(label) ? label :
        label.querySelector('input[type="checkbox"], [role="checkbox"], [role="switch"]') ||
        (label.getAttribute('for') ? document.getElementById(label.getAttribute('for')) : null);
      if (!isControl(control) || !visible(control)) continue;
      if (!candidates.some(item => item.control === control)) candidates.push({ label, control });
    }
    if (candidates.length !== 1) return { capability: candidates.length ? 'ambiguous' : 'unsupported', matches: candidates.length };
    const { label, control } = candidates[0];
    const checked = typeof control.checked === 'boolean' ? control.checked :
      control.getAttribute('aria-checked') === 'true' ? true :
      control.getAttribute('aria-checked') === 'false' ? false : null;
    const disabled = Boolean(control.disabled || control.getAttribute('aria-disabled') === 'true');
    if (checked == null) return { capability: 'unknown', matches: 1, label: norm(label.innerText || label.textContent || label.getAttribute('aria-label')) };
    if (click && checked !== wanted) {
      if (disabled) return { capability: 'disabled', matches: 1, checked };
      control.click();
    }
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .d-modal, .semi-modal'))
      .filter(visible).map(el => norm(el.innerText || el.textContent || '')).filter(Boolean);
    return { capability: 'supported', matches: 1, checked, disabled,
      label: norm(label.innerText || label.textContent || label.getAttribute('aria-label')), dialogs };
  })(${JSON.stringify(LABELS[key])}, ${JSON.stringify(wanted)}, ${JSON.stringify(click)})`;
}

export async function applyDeclarations(page, requested = {}) {
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) throw new ArgumentError('Declarations must be an object');
  for (const [key, value] of Object.entries(requested)) {
    if (!Object.hasOwn(LABELS, key) || typeof value !== 'boolean') throw new ArgumentError('Declarations support explicit original and aiGenerated booleans');
  }
  const observed = {}, capabilities = { original: 'unknown', aiGenerated: 'unknown' };
  for (const [key, wanted] of Object.entries(requested)) {
    const before = await page.evaluate(declarationStateScript(key, wanted));
    capabilities[key] = before?.capability || 'unknown';
    if (before?.capability !== 'supported') throw new CommandExecutionError(`Requested ${key} declaration control is ${capabilities[key]}; the note remains unsubmitted`);
    if (before.dialogs?.length) throw new CommandExecutionError(`Resolve the current declaration dialog before setting ${key}; the note remains unsubmitted`);
    if (before.checked !== wanted) {
      if (before.disabled) throw new CommandExecutionError(`Requested ${key} declaration is disabled; the note remains unsubmitted`);
      await page.evaluate(declarationStateScript(key, wanted, true));
      await page.wait?.({ time: 0.1 });
    }
    const after = await page.evaluate(declarationStateScript(key, wanted));
    if (after?.capability !== 'supported' || after.checked !== wanted || after.dialogs?.length) {
      throw new CommandExecutionError(`Could not confirm requested ${key} declaration in the composer; the note remains unsubmitted`);
    }
    observed[key] = after.checked;
  }
  return { requested: { ...requested }, observed, confirmed: true, capabilities,
    verification: 'composer-controls-only; saved declaration fields require platform readback' };
}

/** Read the visible declaration controls without changing them. */
export async function readDeclarations(page) {
  const values = {};
  const capabilities = {};
  for (const key of Object.keys(LABELS)) {
    const state = await page.evaluate(declarationStateScript(key, false));
    const capability = state?.capability || 'unknown';
    capabilities[key] = capability === 'unsupported' ? 'unavailable' : capability;
    if (capability === 'supported' && typeof state.checked === 'boolean') values[key] = state.checked;
  }
  return { values, capabilities, verification: 'saved-composer-controls' };
}
