    const connections = boot.connections || [];
    const projects = boot.projects || [];
    const sourceInput = document.getElementById("source");
    const targetInput = document.getElementById("target");
    const results = document.getElementById("results");
    const optionsBox = document.getElementById("options");

    function display(endpoint) {
      if (!endpoint || !endpoint.value) return "";
      if (endpoint.kind === "database") {
        const name = endpoint.profileName || endpoint.server || "localhost";
        return name + " / " + endpoint.value;
      }
      return endpoint.value;
    }

    function paint() {
      sourceInput.value = display(state.source);
      targetInput.value = display(state.target);
      document.getElementById("sourceIcon").innerHTML = endpointIcon(state.source, "project");
      document.getElementById("targetIcon").innerHTML = endpointIcon(state.target, "database");
      document.getElementById("excludePermissions").checked = state.options.excludePermissions;
      document.getElementById("excludeRoleMembership").checked = state.options.excludeRoleMembership;
      document.getElementById("excludeUsers").checked = state.options.excludeUsers;
      document.getElementById("compareSide").disabled = !state.source || !state.target;
    }

    function endpointIcon(endpoint, fallback) {
      const kind = endpoint && endpoint.kind ? endpoint.kind : fallback;
      const databaseIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4"/></svg>';
      const projectIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M3 2h7l3 3v9H3V2z"/></svg>';
      return kind === "database" ? databaseIcon : projectIcon;
    }

    let dialogSide = "target";
    let dacpacValue = "";
    let projectValue = "";

    function selectedKind() {
      const picked = document.querySelector('input[name="kind"]:checked');
      return picked ? picked.value : "database";
    }

    function fillSelect(select, items, placeholder) {
      select.innerHTML = "";
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = placeholder;
      select.appendChild(empty);
      for (const item of items) {
        const option = document.createElement("option");
        option.value = item.value;
        option.textContent = item.label;
        select.appendChild(option);
      }
    }

    function connectionItems() {
      return connections.map((item) => ({ value: item.id || item.profileName, label: item.profileName }));
    }

    function showKind(kind) {
      document.getElementById("paneDatabase").classList.toggle("open", kind === "database");
      document.getElementById("paneDacpac").classList.toggle("open", kind === "dacpac");
      document.getElementById("paneProject").classList.toggle("open", kind === "project");
      refreshOk();
    }

    function refreshOk() {
      const kind = selectedKind();
      let ready = false;
      if (kind === "database") {
        ready = Boolean(document.getElementById("connectionSelect").value && document.getElementById("databaseSelect").value);
      } else if (kind === "dacpac") {
        ready = Boolean(dacpacValue);
      } else {
        ready = Boolean(document.getElementById("projectSelect").value || projectValue);
      }
      document.getElementById("okBtn").disabled = !ready;
    }

    function onConnectionChange() {
      const id = document.getElementById("connectionSelect").value;
      const databaseSelect = document.getElementById("databaseSelect");
      if (!id) {
        fillSelect(databaseSelect, [], t("Select"));
        databaseSelect.disabled = true;
        refreshOk();
        return;
      }
      fillSelect(databaseSelect, [], t("Reading…"));
      databaseSelect.disabled = true;
      refreshOk();
      vscode.postMessage({ type: "listDatabases", connectionId: id });
    }

    function openDialog(side) {
      dialogSide = side;
      document.getElementById("dialogTitle").textContent = side === "source" ? t("Select source") : t("Select target");
      const current = side === "source" ? state.source : state.target;
      const kind = current && current.kind ? current.kind : (side === "target" ? "database" : "project");
      const radio = document.querySelector('input[name="kind"][value="' + kind + '"]');
      if (radio) radio.checked = true;
      dacpacValue = current && current.kind === "dacpac" ? current.value : "";
      document.getElementById("dacpacPath").textContent = dacpacValue;
      projectValue = current && current.kind === "project" ? current.value : "";
      fillSelect(document.getElementById("connectionSelect"), connectionItems(), t("Select"));
      fillSelect(document.getElementById("databaseSelect"), [], t("Select"));
      document.getElementById("databaseSelect").disabled = true;
      const projectItems = projects.map((item) => ({ value: item.value, label: item.name }));
      if (projectValue && !projectItems.some((item) => item.value === projectValue)) {
        projectItems.push({ value: projectValue, label: projectValue });
      }
      fillSelect(document.getElementById("projectSelect"), projectItems, t("Select"));
      if (projectValue) document.getElementById("projectSelect").value = projectValue;
      if (current && current.kind === "database") {
        const match = connections.find((item) => item.id === current.connectionId || item.profileName === current.profileName);
        if (match) {
          document.getElementById("connectionSelect").value = match.id || match.profileName;
          onConnectionChange();
          if (current.value) document.getElementById("databaseSelect").value = current.value;
        }
      }
      showKind(kind);
      document.getElementById("backdrop").classList.add("open");
      vscode.postMessage({ type: "refreshConnections" });
    }

    function closeDialog() {
      document.getElementById("backdrop").classList.remove("open");
    }

    function acceptDialog() {
      const kind = selectedKind();
      let endpoint = null;
      if (kind === "database") {
        const id = document.getElementById("connectionSelect").value;
        const connection = connections.find((item) => (item.id || item.profileName) === id);
        const database = document.getElementById("databaseSelect").value;
        if (!connection || !database) return;
        endpoint = {
          kind: "database",
          value: database,
          connectionId: connection.id,
          profileName: connection.profileName,
          server: connection.server,
        };
      } else if (kind === "dacpac") {
        if (!dacpacValue) return;
        endpoint = { kind: "dacpac", value: dacpacValue };
      } else {
        const value = document.getElementById("projectSelect").value || projectValue;
        if (!value) return;
        endpoint = { kind: "project", value };
      }
      state[dialogSide] = endpoint;
      results.textContent = "";
      closeDialog();
      paint();
    }

    function readOptions() {
      state.options.excludePermissions = document.getElementById("excludePermissions").checked;
      state.options.excludeRoleMembership = document.getElementById("excludeRoleMembership").checked;
      state.options.excludeUsers = document.getElementById("excludeUsers").checked;
    }

    document.getElementById("sourceBrowse").addEventListener("click", () => openDialog("source"));
    document.getElementById("targetBrowse").addEventListener("click", () => openDialog("target"));
    document.getElementById("closeDialog").addEventListener("click", closeDialog);
    document.getElementById("cancelBtn").addEventListener("click", closeDialog);
    document.getElementById("okBtn").addEventListener("click", acceptDialog);
    for (const radio of document.querySelectorAll('input[name="kind"]')) {
      radio.addEventListener("change", () => showKind(selectedKind()));
    }
    document.getElementById("connectionSelect").addEventListener("change", onConnectionChange);
    document.getElementById("databaseSelect").addEventListener("change", refreshOk);
    document.getElementById("projectSelect").addEventListener("change", () => {
      projectValue = document.getElementById("projectSelect").value;
      refreshOk();
    });
    document.getElementById("dacpacBrowse").addEventListener("click", () => {
      vscode.postMessage({ type: "browseFile", fileKind: "dacpac" });
    });
    document.getElementById("projectBrowse").addEventListener("click", () => {
      vscode.postMessage({ type: "browseFile", fileKind: "project" });
    });
    document.getElementById("switchBtn").addEventListener("click", swap);
    document.getElementById("switchMid").addEventListener("click", swap);
    document.getElementById("optionsBtn").addEventListener("click", () => {
      optionsBox.classList.toggle("open");
    });
    for (const id of ["excludePermissions", "excludeRoleMembership", "excludeUsers"]) {
      document.getElementById(id).addEventListener("change", readOptions);
    }
    document.getElementById("saveBtn").addEventListener("click", () => {
      readOptions();
      vscode.postMessage({ type: "save", state });
    });
    document.getElementById("openBtn").addEventListener("click", () => {
      vscode.postMessage({ type: "open" });
    });
    document.getElementById("compare").addEventListener("click", runCompare);
    document.getElementById("compareSide").addEventListener("click", runCompare);
    document.getElementById("apply").addEventListener("click", () => {
      if (applying) return;
      const rows = diffRows.filter((row) => checked.has(row.id));
      if (!rows.length) return;
      applying = true;
      updateApplyButton();
      vscode.postMessage({ type: "apply", source: state.source, target: state.target, rows });
    });

    function swap() {
      const source = state.source;
      state.source = state.target;
      state.target = source;
      diffRows = [];
      checked = new Set();
      selectedId = "";
      results.textContent = "";
      updateApplyButton();
      paint();
    }

    let diffRows = [];
    let checked = new Set();
    let groupBy = "schema";
    let textFilter = "";
    let schemaFilter = new Set();
    let typeFilter = new Set();
    let useSchemaFilter = false;
    let useTypeFilter = false;
    let compareGen = 0;
    let selectedId = "";
    let colWidths = { type: 120, source: 0, action: 120, target: 0 };
    let detailHeight = 280;
    let detailSaved = null;
    let applying = false;

    function runCompare() {
      readOptions();
      if (!state.source || !state.target) {
        results.innerHTML = "<p style='padding:12px'>" + escapeHtml(t("Choose a source and a target.")) + "</p>";
        return;
      }
      compareGen += 1;
      const gen = compareGen;
      document.body.classList.add("busy");
      document.getElementById("stop").disabled = false;
      document.getElementById("apply").disabled = true;
      results.innerHTML = "<div class='comparing'><div class='spinner'></div><div>" + escapeHtml(t("Comparing…")) + "</div></div>";
      vscode.postMessage({
        type: "compare",
        source: state.source,
        target: state.target,
        generation: gen,
      });
    }

    document.getElementById("stop").addEventListener("click", () => {
      compareGen += 1;
      document.body.classList.remove("busy");
      document.getElementById("stop").disabled = true;
      diffRows = [];
      checked = new Set();
      updateApplyButton();
      results.innerHTML = "<p style='padding:12px'>" + escapeHtml(t("Comparison stopped.")) + "</p>";
      vscode.postMessage({ type: "stopCompare" });
    });

    function databaseName() {
      const endpoint = state.target && state.target.kind === "database"
        ? state.target
        : state.source && state.source.kind === "database"
          ? state.source
          : null;
      return endpoint ? endpoint.value : "";
    }

    function visibleRows() {
      const query = textFilter.trim().toLowerCase();
      return diffRows.filter((row) => {
        if (useSchemaFilter && !schemaFilter.has(row.schema)) return false;
        if (useTypeFilter && !typeFilter.has(row.type)) return false;
        if (!query) return true;
        const blob = (row.sourceName + " " + row.targetName + " " + row.schema).toLowerCase();
        return blob.includes(query);
      });
    }

    function renderGrid() {
      const wrap = results.querySelector(".grid-wrap");
      const keepTop = wrap ? wrap.scrollTop : 0;
      const keepLeft = wrap ? wrap.scrollLeft : 0;
      const rows = visibleRows();
      const selectedCount = rows.filter((row) => checked.has(row.id)).length;
      const adds = diffRows.filter((row) => row.action === "add").length;
      const deletes = diffRows.filter((row) => row.action === "delete").length;
      const schemas = countBy(diffRows, "schema");
      const types = countBy(diffRows, "type");
      results.innerHTML = `
        <div class="summary">
          <strong>${escapeHtml(t("{0} differences", diffRows.length))}</strong>
          <span>${escapeHtml(t("{0} change", diffRows.filter((row) => row.action === "change").length))}</span>
          <span>${escapeHtml(t("{0} add", adds))}</span>
          <span>${escapeHtml(t("{0} delete", deletes))}</span>
          <input id="textFilter" placeholder="${escapeAttr(t("Filter objects"))}" value="${escapeAttr(textFilter)}">
          <button id="filterBtn" type="button">${escapeHtml(t("Filter"))}</button>
          <label>${escapeHtml(t("Group by"))}
            <select id="groupBy">
              <option value="none">${escapeHtml(t("Nothing"))}</option>
              <option value="action">${escapeHtml(t("Action"))}</option>
              <option value="schema">${escapeHtml(t("Schema"))}</option>
              <option value="type">${escapeHtml(t("Type"))}</option>
            </select>
          </label>
          <span id="selectedCount">${escapeHtml(t("{0} of {1} selected", selectedCount, rows.length))}</span>
        </div>
        <div id="filterPanel" class="options"></div>
        <div class="grid-wrap">
          <div class="grid-head" style="grid-template-columns: ${columnTemplate()}">
            <div class="h" data-col="type">${escapeHtml(t("Type"))}<i class="grip"></i></div>
            <div class="h" data-col="source">${escapeHtml(t("Name in source"))}<i class="grip"></i></div>
            <div class="h check"><input id="checkAll" type="checkbox"></div>
            <div class="h" data-col="action">${escapeHtml(t("Action"))}<i class="grip"></i></div>
            <div class="h" data-col="target">${escapeHtml(t("Name in target"))}<i class="grip"></i></div>
          </div>
          ${gridBody(rows)}
        </div>
        <div class="splitter">
          <button id="detailToggle" class="detail-toggle" type="button"></button>
        </div>
        <div class="detail">
          <div class="detail-head">${escapeHtml(t("Detail"))} <span id="detailTitle"></span></div>
          <div class="detail-split">
            <div id="detailSource" class="code empty"></div>
            <div id="detailTarget" class="code empty"></div>
            <div id="detailMap" class="minimap"></div>
          </div>
        </div>`;
      const nextWrap = results.querySelector(".grid-wrap");
      if (nextWrap) {
        nextWrap.scrollTop = keepTop;
        nextWrap.scrollLeft = keepLeft;
      }
      document.getElementById("groupBy").value = groupBy;
      document.getElementById("textFilter").addEventListener("input", (event) => {
        textFilter = event.target.value;
        const caret = event.target.selectionStart;
        renderGrid();
        const input = document.getElementById("textFilter");
        input.focus();
        input.setSelectionRange(caret, caret);
      });
      document.getElementById("groupBy").addEventListener("change", (event) => {
        groupBy = event.target.value;
        renderGrid();
      });
      document.getElementById("filterBtn").addEventListener("click", () => {
        const panel = document.getElementById("filterPanel");
        panel.classList.toggle("open");
        if (panel.classList.contains("open")) {
          panel.innerHTML = filterMarkup(schemas, types);
          bindFilter(panel);
        }
      });
      const checkAll = document.getElementById("checkAll");
      checkAll.checked = rows.length > 0 && selectedCount === rows.length;
      checkAll.indeterminate = selectedCount > 0 && selectedCount < rows.length;
      checkAll.addEventListener("change", () => {
        for (const row of rows) {
          if (checkAll.checked) checked.add(row.id);
          else checked.delete(row.id);
        }
        for (const box of results.querySelectorAll("input.row-check")) {
          box.checked = checkAll.checked;
        }
        checkAll.indeterminate = false;
        updateSelectionCount();
        updateApplyButton();
      });
      for (const box of results.querySelectorAll("input.row-check")) {
        box.addEventListener("click", (event) => event.stopPropagation());
        box.addEventListener("change", (event) => {
          const id = event.target.dataset.id;
          if (event.target.checked) checked.add(id);
          else checked.delete(id);
          const visible = visibleRows();
          const picked = visible.filter((row) => checked.has(row.id)).length;
          checkAll.checked = visible.length > 0 && picked === visible.length;
          checkAll.indeterminate = picked > 0 && picked < visible.length;
          updateSelectionCount();
          updateApplyButton();
        });
      }
      for (const row of results.querySelectorAll(".grid-row.object")) {
        row.addEventListener("click", () => selectRow(row.dataset.id));
      }
      bindResize();
      bindDetailToggle();
      updateApplyButton();
      if (selectedId) {
        const current = results.querySelector(`.grid-row.object[data-id="${selectedId}"]`);
        if (current) current.classList.add("selected");
      }
    }

    function paintDetailToggle() {
      const detail = results.querySelector(".detail");
      const button = document.getElementById("detailToggle");
      if (detail) detail.style.height = detailHeight + "px";
      if (!button) return;
      const expanded = detailSaved != null;
      button.title = expanded ? t("Restore detail") : t("Expand detail");
      button.innerHTML = expanded
        ? '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 4l4 4 4-4"/></svg>'
        : '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 8l4-4 4 4"/></svg>';
    }

    function detailHeightLimits() {
      const summary = results.querySelector(".summary");
      const filter = document.getElementById("filterPanel");
      const splitter = results.querySelector(".splitter");
      const chrome = (summary ? summary.offsetHeight : 0)
        + (filter ? filter.offsetHeight : 0)
        + (splitter ? splitter.offsetHeight : 0);
      return {
        min: 80,
        max: Math.max(80, results.clientHeight - chrome - 30)
      };
    }

    function toggleDetailSize() {
      if (detailSaved == null) {
        detailSaved = detailHeight;
        detailHeight = detailHeightLimits().max;
      } else {
        detailHeight = detailSaved;
        detailSaved = null;
      }
      paintDetailToggle();
    }

    function bindDetailToggle() {
      paintDetailToggle();
      const button = document.getElementById("detailToggle");
      const splitter = results.querySelector(".splitter");
      if (button) {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          toggleDetailSize();
        });
      }
      if (!splitter) return;
      splitter.addEventListener("mousedown", (event) => {
        if (event.button !== 0 || event.target.closest("#detailToggle")) return;
        event.preventDefault();
        const startY = event.clientY;
        const startHeight = detailHeight;
        const limits = detailHeightLimits();
        const previousCursor = document.body.style.cursor;
        const previousSelect = document.body.style.userSelect;
        document.body.style.cursor = "ns-resize";
        document.body.style.userSelect = "none";
        const move = (ev) => {
          const next = startHeight + (startY - ev.clientY);
          detailHeight = Math.min(limits.max, Math.max(limits.min, next));
          detailSaved = null;
          paintDetailToggle();
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          document.body.style.cursor = previousCursor;
          document.body.style.userSelect = previousSelect;
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      });
    }

    function updateSelectionCount() {
      const label = document.getElementById("selectedCount");
      if (!label) return;
      const visible = visibleRows();
      const picked = visible.filter((row) => checked.has(row.id)).length;
      label.textContent = t("{0} of {1} selected", picked, visible.length);
    }

    function setApplying(active, text) {
      applying = active;
      document.body.classList.toggle("busy", active);
      let banner = document.getElementById("applyStatus");
      if (!banner) {
        banner = document.createElement("div");
        banner.id = "applyStatus";
        banner.className = "apply-status";
        banner.innerHTML = "<div class='spinner'></div><div id='applyStatusText'></div>";
        document.body.appendChild(banner);
      }
      const label = document.getElementById("applyStatusText");
      if (label) label.textContent = text || t("Applying…");
      banner.hidden = !active;
      updateApplyButton();
    }

    function updateApplyButton() {
      const button = document.getElementById("apply");
      if (!button) return;
      const toProject = state.source && state.source.kind === "database" && state.target && state.target.kind === "project";
      const toDatabase = state.source && state.source.kind === "project" && state.target && state.target.kind === "database";
      const any = diffRows.some((row) => checked.has(row.id));
      button.disabled = applying || !(any && (toProject || toDatabase));
      button.title = toDatabase
        ? t("Apply only the checked objects to the database. Publish sends the whole project.")
        : toProject
          ? t("Write the checked objects into the project.")
          : t("Choose a project and a database.");
    }

    function columnTemplate() {
      const source = colWidths.source > 0 ? colWidths.source + "px" : "minmax(80px, 1fr)";
      const target = colWidths.target > 0 ? colWidths.target + "px" : "minmax(80px, 1fr)";
      return `${colWidths.type}px ${source} 36px ${colWidths.action}px ${target}`;
    }

    function applyColumns() {
      const template = columnTemplate();
      for (const el of results.querySelectorAll(".grid-head, .grid-row")) {
        el.style.gridTemplateColumns = template;
      }
    }

    function bindResize() {
      for (const grip of results.querySelectorAll(".grip")) {
        grip.addEventListener("mousedown", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const key = grip.parentElement.dataset.col;
          const startX = event.clientX;
          const start = colWidths[key] > 0 ? colWidths[key] : grip.parentElement.getBoundingClientRect().width;
          const move = (ev) => {
            colWidths[key] = Math.max(key === "type" || key === "action" ? 56 : 80, Math.round(start + ev.clientX - startX));
            applyColumns();
          };
          const up = () => {
            document.body.style.userSelect = "";
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
          };
          document.body.style.userSelect = "none";
          window.addEventListener("mousemove", move);
          window.addEventListener("mouseup", up);
        });
      }
    }

    function gridBody(rows) {
      const template = columnTemplate();
      const paint = (items) => items.map((row) => rowHtml(row, template)).join("");
      if (groupBy === "none") return paint(rows);
      const groups = new Map();
      for (const row of rows) {
        const key = groupBy === "action" ? row.actionLabel : groupBy === "type" ? row.typeLabel : row.schema;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
      let html = "";
      for (const [key, items] of groups) {
        html += `<div class="grid-group">${escapeHtml(key)} (${items.length})</div>`;
        html += paint(items);
      }
      return html;
    }

    function rowHtml(row, template) {
      return `<div class="grid-row object" data-id="${escapeAttr(row.id)}" style="grid-template-columns: ${template}">
        <div class="cell">${escapeHtml(row.typeLabel)}</div>
        <div class="cell">${escapeHtml(row.sourceName)}</div>
        <div class="cell check"><input class="row-check" data-id="${escapeAttr(row.id)}" type="checkbox" ${checked.has(row.id) ? "checked" : ""}></div>
        <div class="cell">${escapeHtml(row.actionLabel)}</div>
        <div class="cell">${escapeHtml(row.targetName)}</div>
      </div>`;
    }

    function filterMarkup(schemas, types) {
      const schemaBoxes = [...schemas].map(([name, count]) =>
        `<label><input type="checkbox" data-filter="schema" value="${escapeAttr(name)}" ${!useSchemaFilter || schemaFilter.has(name) ? "checked" : ""}> ${escapeHtml(name)} ${count}</label>`
      ).join("");
      const typeBoxes = [...types].map(([name, count]) =>
        `<label><input type="checkbox" data-filter="type" value="${escapeAttr(name)}" ${!useTypeFilter || typeFilter.has(name) ? "checked" : ""}> ${escapeHtml(TYPE_LABEL(name))} ${count}</label>`
      ).join("");
      return `<h2>${escapeHtml(t("Schema"))}</h2>${schemaBoxes}<h2>${escapeHtml(t("Object type"))}</h2>${typeBoxes}`;
    }

    function TYPE_LABEL(type) {
      return t(({ Table: "Table", Procedure: "Procedure", Function: "Function", View: "View", Trigger: "Trigger" })[type] || type);
    }

    function bindFilter(panel) {
      for (const box of panel.querySelectorAll("input")) {
        box.addEventListener("change", () => {
          const kind = box.dataset.filter;
          const all = [...panel.querySelectorAll(`input[data-filter="${kind}"]`)];
          const picked = new Set(all.filter((item) => item.checked).map((item) => item.value));
          if (kind === "schema") {
            useSchemaFilter = picked.size !== all.length;
            schemaFilter = picked;
          } else {
            useTypeFilter = picked.size !== all.length;
            typeFilter = picked;
          }
          renderGrid();
        });
      }
    }

    function selectRow(id) {
      selectedId = id;
      for (const row of results.querySelectorAll(".grid-row.object")) {
        row.classList.toggle("selected", row.dataset.id === id);
      }
      const row = diffRows.find((item) => item.id === id);
      if (!row) return;
      const title = document.getElementById("detailTitle");
      if (title) title.textContent = row.sourceName || row.targetName;
      const source = document.getElementById("detailSource");
      const target = document.getElementById("detailTarget");
      const map = document.getElementById("detailMap");
      if (source) {
        source.textContent = t("Reading…");
        source.classList.remove("empty");
      }
      if (target) {
        target.textContent = "";
        target.classList.add("empty");
      }
      if (map) map.innerHTML = "";
      vscode.postMessage({ type: "script", id, row, database: databaseName() });
    }

    function countBy(rows, field) {
      const map = new Map();
      for (const row of rows) {
        map.set(row[field], (map.get(row[field]) || 0) + 1);
      }
      return [...map.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), "es", { sensitivity: "base" }));
    }

    function paintScripts(sourceText, targetText, action) {
      const source = document.getElementById("detailSource");
      const target = document.getElementById("detailTarget");
      const map = document.getElementById("detailMap");
      if (!source || !target) return;
      const aligned = alignScripts(sourceText, targetText, action);
      source.classList.toggle("empty", !sourceText);
      target.classList.toggle("empty", !targetText);
      source.innerHTML = sourceText ? paneHtml(aligned, "left") : "";
      target.innerHTML = targetText ? paneHtml(aligned, "right") : "";
      if (map) map.innerHTML = mapHtml(aligned);
      source.scrollTop = 0;
      target.scrollTop = 0;
    }

    function paneHtml(rows, side) {
      return rows.map((row) => {
        const text = side === "left" ? row.left : row.right;
        const number = side === "left" ? row.leftNo : row.rightNo;
        let cls = "line";
        if (side === "left" && (row.kind === "add" || row.kind === "change")) cls += " add";
        if (side === "right" && (row.kind === "del" || row.kind === "change")) cls += " del";
        return `<div class="${cls}"><span class="no">${number || ""}</span><span class="txt">${text ? highlightSql(text) : ""}</span></div>`;
      }).join("");
    }

    function mapHtml(rows) {
      const total = Math.max(rows.length, 1);
      let html = "";
      let start = -1;
      let kind = "";
      const flush = (end) => {
        if (start < 0) return;
        const top = (start / total) * 100;
        const height = Math.max(((end - start) / total) * 100, 0.7);
        html += `<i class="mark ${kind}" style="top:${top}%;height:${height}%"></i>`;
      };
      rows.forEach((row, index) => {
        const next = row.kind === "same" ? "" : row.kind;
        if (next !== kind) {
          flush(index);
          start = next ? index : -1;
          kind = next;
        }
      });
      flush(rows.length);
      return html;
    }

    function alignScripts(sourceText, targetText, action) {
      const left = scriptLines(sourceText);
      const right = scriptLines(targetText);
      if (!sourceText) return numberRows(right.map((line) => ({ left: "", right: line, kind: "del" })));
      if (!targetText || action === "add") return numberRows(left.map((line) => ({ left: line, right: "", kind: "add" })));
      if (action === "delete") return numberRows(right.map((line) => ({ left: "", right: line, kind: "del" })));
      if (left.length + right.length > 5000) return numberRows(foldOps(fallbackOps(left, right)));
      return numberRows(foldOps(myers(left, right)));
    }

    function scriptLines(text) {
      const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      return lines;
    }

    function numberRows(rows) {
      let leftNo = 0;
      let rightNo = 0;
      for (const row of rows) {
        row.leftNo = row.kind === "del" ? "" : ++leftNo;
        row.rightNo = row.kind === "add" ? "" : ++rightNo;
      }
      return rows;
    }

    function foldOps(ops) {
      const rows = [];
      let i = 0;
      while (i < ops.length) {
        if (ops[i].type === "equal") {
          rows.push({ left: ops[i].left, right: ops[i].right, kind: "same" });
          i += 1;
          continue;
        }
        const deleted = [];
        const inserted = [];
        while (i < ops.length && ops[i].type === "delete") { deleted.push(ops[i].left); i += 1; }
        while (i < ops.length && ops[i].type === "insert") { inserted.push(ops[i].right); i += 1; }
        const count = Math.max(deleted.length, inserted.length);
        for (let j = 0; j < count; j += 1) {
          const left = j < deleted.length ? deleted[j] : "";
          const right = j < inserted.length ? inserted[j] : "";
          rows.push({ left, right, kind: left && right ? "change" : left ? "add" : "del" });
        }
      }
      return rows;
    }

    function fallbackOps(a, b) {
      let start = 0;
      while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
      let endA = a.length;
      let endB = b.length;
      while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
      const ops = [];
      for (let i = 0; i < start; i += 1) ops.push({ type: "equal", left: a[i], right: b[i] });
      for (let i = start; i < endA; i += 1) ops.push({ type: "delete", left: a[i] });
      for (let i = start; i < endB; i += 1) ops.push({ type: "insert", right: b[i] });
      for (let i = 0; i < a.length - endA; i += 1) ops.push({ type: "equal", left: a[endA + i], right: b[endB + i] });
      return ops;
    }

    function myers(a, b) {
      const n = a.length;
      const m = b.length;
      const max = n + m;
      const v = { 1: 0 };
      const trace = [];
      for (let d = 0; d <= max; d += 1) {
        trace.push(Object.assign({}, v));
        for (let k = -d; k <= d; k += 2) {
          const prevLeft = v[k - 1] || 0;
          const prevRight = v[k + 1] || 0;
          let x = (k === -d || (k !== d && prevLeft < prevRight)) ? prevRight : prevLeft + 1;
          let y = x - k;
          while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
          v[k] = x;
          if (x >= n && y >= m) return backtrack(trace, a, b);
        }
      }
      return fallbackOps(a, b);
    }

    function backtrack(trace, a, b) {
      let x = a.length;
      let y = b.length;
      const result = [];
      for (let d = trace.length - 1; d >= 0; d -= 1) {
        const snap = trace[d];
        const k = x - y;
        const prevK = (k === -d || (k !== d && (snap[k - 1] || 0) < (snap[k + 1] || 0))) ? k + 1 : k - 1;
        const prevX = snap[prevK] || 0;
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) {
          result.push({ type: "equal", left: a[x - 1], right: b[y - 1] });
          x -= 1;
          y -= 1;
        }
        if (d > 0) {
          if (x === prevX) { result.push({ type: "insert", right: b[y - 1] }); y -= 1; }
          else { result.push({ type: "delete", left: a[x - 1] }); x -= 1; }
        }
      }
      return result.reverse();
    }

    function highlightSql(text) {
      const keywords = new Set("add,all,alter,and,as,asc,begin,between,bigint,bit,by,case,char,clustered,constraint,create,cross,date,datetime,datetime2,datetimeoffset,decimal,declare,default,delete,desc,distinct,drop,else,end,exec,execute,exists,float,foreign,from,function,go,group,having,identity,if,in,index,inner,insert,int,into,is,join,key,left,like,money,nchar,nocount,not,null,numeric,nvarchar,on,or,order,outer,over,partition,primary,procedure,real,return,right,select,set,table,then,time,top,trigger,union,unique,uniqueidentifier,update,values,varbinary,varchar,view,when,where,with,xml".split(","));
      const src = String(text || "");
      let html = "";
      let i = 0;
      while (i < src.length) {
        if (src.startsWith("--", i)) {
          const end = src.indexOf("\n", i);
          const chunk = src.slice(i, end < 0 ? src.length : end);
          html += `<span class="sql-cmt">${escapeHtml(chunk)}</span>`;
          i += chunk.length;
          continue;
        }
        if (src.startsWith("/*", i)) {
          const end = src.indexOf("*/", i + 2);
          const chunk = src.slice(i, end < 0 ? src.length : end + 2);
          html += `<span class="sql-cmt">${escapeHtml(chunk)}</span>`;
          i += chunk.length;
          continue;
        }
        if (src[i] === "'" || (src[i] === "N" && src[i + 1] === "'")) {
          let j = src[i] === "N" ? i + 2 : i + 1;
          while (j < src.length) {
            if (src[j] === "'" && src[j + 1] === "'") { j += 2; continue; }
            if (src[j] === "'") { j += 1; break; }
            j += 1;
          }
          html += `<span class="sql-str">${escapeHtml(src.slice(i, j))}</span>`;
          i = j;
          continue;
        }
        if (/[0-9]/.test(src[i]) && (i === 0 || !/[\w]/.test(src[i - 1]))) {
          let j = i;
          while (j < src.length && /[0-9.]/.test(src[j])) j += 1;
          html += `<span class="sql-num">${escapeHtml(src.slice(i, j))}</span>`;
          i = j;
          continue;
        }
        if (/[A-Za-z_]/.test(src[i])) {
          let j = i;
          while (j < src.length && /[\w@#$]/.test(src[j])) j += 1;
          const word = src.slice(i, j);
          html += keywords.has(word.toLowerCase()) ? `<span class="sql-kw">${escapeHtml(word)}</span>` : escapeHtml(word);
          i = j;
          continue;
        }
        html += escapeHtml(src[i]);
        i += 1;
      }
      return html;
    }

    function escapeHtml(value) {
      return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    function escapeAttr(value) {
      return escapeHtml(value).replace(/"/g, "&quot;");
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "compared") {
        document.body.classList.remove("busy");
        document.getElementById("stop").disabled = true;
        diffRows = message.rows || [];
        checked = new Set(diffRows.map((row) => row.id));
        selectedId = "";
        renderGrid();
        updateApplyButton();
      }
      if (message.type === "compareFailed") {
        document.body.classList.remove("busy");
        document.getElementById("stop").disabled = true;
        diffRows = [];
        checked = new Set();
        updateApplyButton();
        results.innerHTML = `<p style="padding:12px">${escapeHtml(message.message || t("Could not compare"))}</p>`;
      }
      if (message.type === "applying") {
        setApplying(true, message.text || t("Applying…"));
      }
      if (message.type === "applied") {
        setApplying(false);
      }
      if (message.type === "script" && message.id === selectedId) {
        const row = diffRows.find((item) => item.id === message.id);
        paintScripts(message.sourceText || "", message.targetText || "", row ? row.action : "");
      }
      if (message.type === "connections" && Array.isArray(message.connections)) {
        connections.splice(0, connections.length, ...message.connections);
        if (document.getElementById("backdrop").classList.contains("open")) {
          const selected = document.getElementById("connectionSelect").value;
          fillSelect(document.getElementById("connectionSelect"), connectionItems(), t("Select"));
          if (selected && [...document.getElementById("connectionSelect").options].some((option) => option.value === selected)) {
            document.getElementById("connectionSelect").value = selected;
          }
          if (document.getElementById("connectionSelect").value) {
            onConnectionChange();
          }
        }
      }
      if (message.type === "databases") {
        if (document.getElementById("connectionSelect").value !== message.connectionId) {
          return;
        }
        const databaseSelect = document.getElementById("databaseSelect");
        const items = (message.databases || []).map((name) => ({ value: name, label: name }));
        fillSelect(databaseSelect, items, t("Select"));
        databaseSelect.disabled = items.length === 0;
        const id = message.connectionId;
        const connection = connections.find((item) => (item.id || item.profileName) === id);
        if (connection && connection.database && items.some((item) => item.value === connection.database)) {
          databaseSelect.value = connection.database;
        }
        refreshOk();
      }
      if (message.type === "filePicked") {
        if (message.fileKind === "dacpac") {
          dacpacValue = message.value;
          document.getElementById("dacpacPath").textContent = message.value;
        } else {
          projectValue = message.value;
          const select = document.getElementById("projectSelect");
          if (![...select.options].some((option) => option.value === message.value)) {
            const option = document.createElement("option");
            option.value = message.value;
            option.textContent = message.value;
            select.appendChild(option);
          }
          select.value = message.value;
        }
        refreshOk();
      }
      if (message.type === "state" && message.state) {
        state.source = message.state.source;
        state.target = message.state.target;
        state.options = message.state.options;
        results.textContent = "";
        paint();
      }
    });

    let syncingScroll = false;
    results.addEventListener("scroll", (event) => {
      const pane = event.target;
      if (syncingScroll || (pane.id !== "detailSource" && pane.id !== "detailTarget")) return;
      const other = document.getElementById(pane.id === "detailSource" ? "detailTarget" : "detailSource");
      if (!other) return;
      syncingScroll = true;
      other.scrollTop = pane.scrollTop;
      other.scrollLeft = pane.scrollLeft;
      syncingScroll = false;
    }, true);
    results.addEventListener("click", (event) => {
      const map = event.target.id === "detailMap" ? event.target : event.target.closest && event.target.closest("#detailMap");
      if (!map) return;
      const rect = map.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
      const target = document.getElementById("detailTarget");
      const source = document.getElementById("detailSource");
      const scroller = target && target.scrollHeight > target.clientHeight ? target : source;
      if (!scroller) return;
      scroller.scrollTop = ratio * (scroller.scrollHeight - scroller.clientHeight);
    });

    paint();
