import { createRequest, readSnapshotFile, summarizeResult } from "/app-logic.js";

const form = document.querySelector("#surface-form");
const beforeInput = document.querySelector("#snapshot-a");
const afterInput = document.querySelector("#snapshot-b");
const beforeFileInput = document.querySelector("#snapshot-a-file");
const afterFileInput = document.querySelector("#snapshot-b-file");
const comparisonInput = document.querySelector("#comparison-input");
const submitButton = document.querySelector("#submit-button");
const resultRegion = document.querySelector("#result");
const summary = document.querySelector("#summary");
const details = document.querySelector("#details");
const modeButtons = [...document.querySelectorAll(".mode-button")];
let mode = "analyze";

function setMode(nextMode) {
  mode = nextMode;
  for (const button of modeButtons) {
    const selected = button.dataset.mode === mode;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
  comparisonInput.hidden = mode !== "diff";
  afterInput.required = mode === "diff";
  submitButton.textContent = mode === "diff" ? "Compare snapshots" : "Analyze snapshot";
  resultRegion.hidden = true;
}

function showResult(value) {
  const view = summarizeResult(value);
  summary.className = `summary ${view.tone}`;
  summary.replaceChildren();
  const heading = document.createElement("strong");
  heading.textContent = view.title;
  const facts = document.createElement("span");
  facts.textContent = view.facts.join(" · ");
  summary.append(heading, facts);
  details.textContent = JSON.stringify(value, null, 2);
  resultRegion.hidden = false;
}

async function loadSnapshotFile(fileInput, textInput) {
  try {
    const text = await readSnapshotFile(fileInput.files?.[0]);
    if (text === null) return;
    textInput.value = text;
    resultRegion.hidden = true;
    textInput.focus();
  } catch (error) {
    showResult({
      status: "error",
      error: {
        code: error?.code ?? "FILE_READ_FAILED",
        message: error instanceof Error ? error.message : "Snapshot file could not be read."
      }
    });
  } finally {
    fileInput.value = "";
  }
}

for (const button of modeButtons) {
  button.addEventListener("click", () => setMode(button.dataset.mode));
}
beforeFileInput.addEventListener("change", () => loadSnapshotFile(beforeFileInput, beforeInput));
afterFileInput.addEventListener("change", () => loadSnapshotFile(afterFileInput, afterInput));

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  resultRegion.hidden = true;
  submitButton.disabled = true;
  try {
    const request = createRequest(mode, beforeInput.value, afterInput.value);
    const response = await fetch(request.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.body)
    });
    showResult(await response.json());
  } catch {
    showResult({ status: "error", error: { code: "REQUEST_FAILED", message: "The local service did not return a result." } });
  } finally {
    submitButton.disabled = false;
  }
});
