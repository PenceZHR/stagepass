const root = document.querySelector<HTMLElement>("#stagepass-interaction");

if (root) {
  root.dataset.ready = "true";
  root.querySelector<HTMLElement>("[data-stagepass-status]")!.textContent =
    "StagePass interaction ready";
}
