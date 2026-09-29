(() => {
  const { apiBase, reviewThreshold } = window.APP_CONFIG;
  const $ = (id) => document.getElementById(id);

  const state = {
    plan: null,
    reviewed: new Set(), // keys like "safety:2"
    flaggedOnly: false,
  };

  const SECTIONS = [
    { key: "visits", label: "Visit schedule" },
    { key: "procedures", label: "Procedures" },
    { key: "staffing", label: "Staffing" },
    { key: "safety", label: "Safety reporting" },
    { key: "billing", label: "Billing" },
    { key: "equipment", label: "Equipment" },
    { key: "pharmacy", label: "Pharmacy" },
    { key: "technology", label: "Technology" },
  ];

  // ---------- helpers ----------
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const isFlagged = (item) => typeof item.confidence === "number" && item.confidence < reviewThreshold;

  function itemsFor(key) {
    const p = state.plan;
    if (key === "pharmacy") return p.pharmacy?.items || [];
    return p[key] || [];
  }

  function openFlags(key) {
    return itemsFor(key).filter((it, i) => isFlagged(it) && !state.reviewed.has(`${key}:${i}`)).length;
  }

  function showView(name) {
    for (const v of ["uploadView", "processingView", "resultsView"]) $(v).hidden = v !== name;
    $("newBtn").hidden = name === "uploadView";
    window.scrollTo(0, 0);
  }

  let toastTimer;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  function setMode(isSample) {
    const pill = $("modePill");
    pill.hidden = false;
    pill.textContent = isSample ? "Sample data" : "Draft, needs review";
    pill.className = "pill " + (isSample ? "pill-muted" : "pill-warn");
  }

  // ---------- upload ----------
  const dz = $("dropzone");
  const fileInput = $("fileInput");

  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); })
  );
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  });
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (f) handleFile(f);
    fileInput.value = "";
  });

  $("sampleBtn").addEventListener("click", () => runSample());
  $("newBtn").addEventListener("click", () => {
    state.plan = null;
    state.reviewed.clear();
    $("modePill").hidden = true;
    $("uploadError").hidden = true;
    showView("uploadView");
  });

  function showUploadError(html) {
    const el = $("uploadError");
    el.innerHTML = html;
    el.hidden = false;
    showView("uploadView");
  }

  async function handleFile(file) {
    $("uploadError").hidden = true;
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
      return showUploadError("That doesn't look like a PDF. Protocols need to be uploaded as <code>.pdf</code> files.");
    }
    if (file.size > 50 * 1024 * 1024) {
      return showUploadError("That file is over 50 MB. Try a smaller protocol or split the appendices out.");
    }

    const stepper = startProcessing(file.name);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`${apiBase}/api/protocols`, { method: "POST", body });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Server returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
      }
      const plan = await res.json();
      await stepper.finish();
      loadPlan(plan);
    } catch (err) {
      stepper.stop();
      const unreachable = err instanceof TypeError; // fetch network failure
      showUploadError(
        (unreachable
          ? `Couldn't reach the backend at <code>${esc(apiBase)}</code>. Is the FastAPI server running?`
          : `Processing failed. ${esc(err.message)}`) +
          ` <button class="link-btn" id="fallbackSample">View sample output instead</button>`
      );
      $("fallbackSample").addEventListener("click", runSample);
    }
  }

  async function runSample() {
    const stepper = startProcessing("sample-protocol-xr214.pdf");
    await stepper.finish(900);
    loadPlan(structuredClone(window.SAMPLE_PLAN));
  }

  // Walks through the pipeline steps on a timer. The backend is a single request
  // for now, so this is cosmetic until we add progress events.
  function startProcessing(filename) {
    showView("processingView");
    $("processingFile").textContent = filename;
    const steps = [...document.querySelectorAll("#steps li")];
    steps.forEach((s) => (s.className = ""));
    let i = 0;
    steps[0].className = "active";
    const timer = setInterval(() => {
      if (i < steps.length - 1) {
        steps[i].className = "done";
        steps[++i].className = "active";
      }
    }, 1400);

    return {
      stop: () => clearInterval(timer),
      finish: (perStep = 250) =>
        new Promise((resolve) => {
          clearInterval(timer);
          const tick = () => {
            steps[i].className = "done";
            if (i < steps.length - 1) {
              steps[++i].className = "active";
              setTimeout(tick, perStep);
            } else setTimeout(resolve, 300);
          };
          setTimeout(tick, perStep);
        }),
    };
  }

  // ---------- results ----------
  function loadPlan(plan) {
    state.plan = plan;
    state.reviewed.clear();
    setMode(!!plan.is_sample);
    showView("resultsView");
    render();
  }

  $("flaggedOnly").addEventListener("change", (e) => {
    state.flaggedOnly = e.target.checked;
    renderSections();
  });

  function render() {
    renderSummary();
    renderNav();
    renderSections();
  }

  function totalFlags() {
    return SECTIONS.reduce((n, s) => n + openFlags(s.key), 0);
  }

  function renderSummary() {
    const p = state.plan.protocol;
    const flags = totalFlags();
    $("summary").innerHTML = `
      <div class="summary card">
        <div class="summary-head">
          <div>
            <div class="eyebrow">${esc(p.registry_id || "")}${p.pages ? ` · ${p.pages} pages` : ""}</div>
            <h1 class="summary-title">${esc(p.title)}</h1>
          </div>
          <div class="summary-actions">
            <button class="btn btn-primary" id="exportPdf">Download PDF</button>
          </div>
        </div>
        <dl class="facts">
          ${fact("Phase", p.phase)}
          ${fact("Sponsor", p.sponsor)}
          ${fact("Therapeutic area", p.therapeutic_area)}
          ${fact("Enrollment", p.enrollment)}
          ${fact("Design", p.design)}
          ${fact("Duration", p.duration)}
        </dl>
        <div class="summary-stats">
          ${stat(state.plan.visits?.length ?? 0, "visits")}
          ${stat(state.plan.procedures?.length ?? 0, "procedures")}
          ${stat(fteTotal().toFixed(2), "est. FTE")}
          <div class="stat ${flags ? "stat-warn" : "stat-ok"}"><strong>${flags}</strong><span>${flags === 1 ? "item needs" : "items need"} review</span></div>
        </div>
      </div>`;
    $("exportPdf").addEventListener("click", exportPdf);
  }

  const fact = (k, v) => (v == null || v === "" ? "" : `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`);
  const stat = (n, label) => `<div class="stat"><strong>${esc(n)}</strong><span>${esc(label)}</span></div>`;
  const fteTotal = () => (state.plan.staffing || []).reduce((n, s) => n + (Number(s.fte) || 0), 0);

  function renderNav() {
    $("sectionNav").innerHTML = SECTIONS.map((s) => {
      const n = openFlags(s.key);
      return `<a href="#sec-${s.key}">${esc(s.label)}${n ? `<span class="badge-count">${n}</span>` : ""}</a>`;
    }).join("");
  }

  function renderSections() {
    const html = SECTIONS.map((s) => {
      const body = RENDERERS[s.key]();
      return `<section class="card section" id="sec-${s.key}">
        <header class="section-head"><h2>${esc(s.label)}</h2>${sectionMeta(s.key)}</header>
        ${body}
      </section>`;
    }).join("");
    $("sections").innerHTML = html;
    bindReviewButtons();
  }

  function sectionMeta(key) {
    const n = openFlags(key);
    return n ? `<span class="pill pill-warn">${n} to review</span>` : `<span class="pill pill-ok">Looks good</span>`;
  }

  // Rows for list-style sections, with review badges and filtering.
  function rows(key, cols) {
    const items = itemsFor(key);
    const visible = items
      .map((it, i) => ({ it, i }))
      .filter(({ it, i }) => !state.flaggedOnly || (isFlagged(it) && !state.reviewed.has(`${key}:${i}`)));
    if (!items.length) return `<p class="empty">Nothing found in the protocol for this category.</p>`;
    if (!visible.length) return `<p class="empty">No open flags here.</p>`;

    return `<div class="table-wrap"><table class="data">
      <thead><tr>${cols.map((c) => `<th>${esc(c.label)}</th>`).join("")}<th class="col-conf">Confidence</th></tr></thead>
      <tbody>${visible
        .map(({ it, i }) => {
          const k = `${key}:${i}`;
          const flagged = isFlagged(it) && !state.reviewed.has(k);
          return `<tr class="${flagged ? "row-flag" : ""}">
            ${cols.map((c, ci) => `<td${ci === 0 ? ' class="cell-main"' : ""}>${c.render ? c.render(it) : esc(it[c.field])}${ci === 0 ? noteFor(it, k, flagged) : ""}</td>`).join("")}
            <td class="col-conf">${confCell(it, k)}</td>
          </tr>`;
        })
        .join("")}</tbody>
    </table></div>`;
  }

  function noteFor(it, k, flagged) {
    const bits = [];
    if (it.notes) bits.push(`<div class="note ${flagged ? "note-warn" : ""}">${esc(it.notes)}</div>`);
    if (it.source_page) bits.push(`<div class="src">p. ${esc(it.source_page)}</div>`);
    return bits.join("");
  }

  function confCell(it, k) {
    if (typeof it.confidence !== "number") return "";
    const pct = Math.round(it.confidence * 100);
    const flagged = isFlagged(it);
    const reviewed = state.reviewed.has(k);
    let html = `<div class="conf"><div class="conf-bar"><span style="width:${pct}%" class="${flagged ? "low" : ""}"></span></div><span class="mono">${pct}%</span></div>`;
    if (flagged) {
      html += reviewed
        ? `<button class="review-btn done" data-key="${k}">Reviewed ✓</button>`
        : `<button class="review-btn" data-key="${k}">Mark reviewed</button>`;
    }
    return html;
  }

  function bindReviewButtons() {
    document.querySelectorAll(".review-btn").forEach((b) =>
      b.addEventListener("click", () => {
        const k = b.dataset.key;
        state.reviewed.has(k) ? state.reviewed.delete(k) : state.reviewed.add(k);
        const y = window.scrollY;
        render();
        window.scrollTo(0, y);
      })
    );
  }

  const visitNames = (ids) => (ids || []).map((id) => `<span class="chip">${esc(id)}</span>`).join(" ");

  const RENDERERS = {
    visits() {
      const visits = state.plan.visits || [];
      if (!visits.length) return `<p class="empty">No visits extracted.</p>`;
      return `<ol class="timeline">${visits
        .map(
          (v) => `<li class="${v.type === "Phone" ? "remote" : ""}">
            <span class="tl-dot"></span>
            <div class="tl-id mono">${esc(v.id)}</div>
            <div class="tl-name">${esc(v.name)}</div>
            <div class="tl-day">${esc(v.day)}${v.window ? ` <span class="muted">${esc(v.window)}</span>` : ""}</div>
            <div class="tl-type">${esc(v.type || "")}</div>
          </li>`
        )
        .join("")}</ol>`;
    },

    procedures() {
      const visits = state.plan.visits || [];
      const procs = (state.plan.procedures || [])
        .map((p, i) => ({ p, i }))
        .filter(({ p, i }) => !state.flaggedOnly || (isFlagged(p) && !state.reviewed.has(`procedures:${i}`)));
      if (!state.plan.procedures?.length) return `<p class="empty">No procedures extracted.</p>`;
      if (!procs.length) return `<p class="empty">No open flags here.</p>`;

      return `<p class="section-sub">Schedule of assessments. Each mark is a procedure required at that visit.</p>
      <div class="table-wrap"><table class="soa">
        <thead><tr><th class="sticky">Procedure</th>${visits
          .map((v) => `<th title="${esc(v.name)} · ${esc(v.day)}"><span class="mono">${esc(v.id)}</span></th>`)
          .join("")}<th class="col-conf">Confidence</th></tr></thead>
        <tbody>${procs
          .map(({ p, i }) => {
            const k = `procedures:${i}`;
            const flagged = isFlagged(p) && !state.reviewed.has(k);
            return `<tr class="${flagged ? "row-flag" : ""}">
              <td class="sticky cell-main">${esc(p.name)} <span class="cat">${esc(p.category || "")}</span>${noteFor(p, k, flagged)}</td>
              ${visits.map((v) => `<td class="mark">${p.visits?.includes(v.id) ? "●" : ""}</td>`).join("")}
              <td class="col-conf">${confCell(p, k)}</td>
            </tr>`;
          })
          .join("")}</tbody>
      </table></div>`;
    },

    staffing() {
      return rows("staffing", [
        { label: "Role", field: "role" },
        { label: "Est. FTE", render: (s) => `<span class="mono">${esc(s.fte)}</span>` },
        { label: "Responsibilities", field: "responsibilities" },
      ]);
    },

    safety() {
      return rows("safety", [
        { label: "Event", field: "event" },
        { label: "Timeline", field: "timeline" },
        { label: "Report to", field: "recipient" },
        { label: "Method", field: "method" },
      ]);
    },

    billing() {
      return rows("billing", [
        { label: "Item", field: "item" },
        {
          label: "Designation",
          render: (b) => {
            const cls = /sponsor/i.test(b.designation) ? "tag-sponsor" : /standard|soc/i.test(b.designation) ? "tag-soc" : "tag-other";
            return `<span class="tag ${cls}">${esc(b.designation)}</span>`;
          },
        },
        { label: "Visits", render: (b) => visitNames(b.visits) },
      ]);
    },

    equipment() {
      return rows("equipment", [
        { label: "Item", field: "item" },
        { label: "Purpose", field: "purpose" },
      ]);
    },

    pharmacy() {
      const ph = state.plan.pharmacy;
      if (!ph) return `<p class="empty">No pharmacy info extracted.</p>`;
      const head = `<p class="section-sub">Investigational pharmacy ${ph.involved ? "<strong>is</strong>" : "is <strong>not</strong>"} involved.</p>`;
      return head + rows("pharmacy", [{ label: "Requirement", field: "item" }]);
    },

    technology() {
      return rows("technology", [
        { label: "System", field: "system" },
        { label: "Purpose", field: "purpose" },
      ]);
    },
  };

  // ---------- export ----------
  function exportPdf() {
    if (!window.jspdf) return toast("PDF library didn't load. Check your internet connection and refresh.");
    try {
      window.buildPlanPdf(state.plan, {
        reviewed: state.reviewed,
        isFlagged,
        sections: SECTIONS,
        itemsFor,
      }).save(`${slug()}-operational-plan.pdf`);
    } catch (err) {
      console.error(err);
      toast("Couldn't generate the PDF.");
    }
  }

  const slug = () =>
    (state.plan.protocol.short_title || state.plan.protocol.registry_id || "protocol")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
})();
