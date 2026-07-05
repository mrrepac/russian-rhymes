import { App, Editor, MarkdownView, Notice, Platform, Plugin, PluginSettingTab, Setting, ToggleComponent, WorkspaceLeaf, setIcon } from "obsidian";
import { RhymeDict } from "./dict";
import { RhymesView, VIEW_TYPE_RHYMES } from "./view";
import { convertDsl } from "./dsl";
import { t } from "./i18n";

interface RhymesSettings {
  doubleCopyMs: number; // 0 = выключено
  /** Видимые лексические слои: [базовая, частотная, обычная, редкая]. Кнопки в панели. */
  lexShow: boolean[];
  /** База URL для скачивания словаря (GitHub-релиз), если папки dict/ нет (мобильный/новая установка). */
  dictUrl: string;
  /** Пасхалка: открыт ли генератор слов (разблокируется словом «фристайл»). */
  genUnlocked: boolean;
}

/** Личный толковый словарь пользователя (из DSL). Порядок массива = порядок в «Значении». */
interface LocalDict {
  id: string;
  name: string;
  words: number;
  enabled: boolean; // тумблер в настройках: показывать ли словарь в выдаче (без удаления файла)
}

const DEFAULT_SETTINGS: RhymesSettings = {
  doubleCopyMs: 400,
  lexShow: [true, true, true, false],
  dictUrl: "https://github.com/mrrepac/russian-rhymes/releases/download/dict/",
  genUnlocked: false,
};

interface PersistedData {
  settings?: RhymesSettings;
  userStress?: Record<string, number>;
  localDicts?: LocalDict[];
}

export default class RussianRhymesPlugin extends Plugin {
  settings: RhymesSettings = DEFAULT_SETTINGS;
  userStress: Record<string, number> = {};
  localDicts: LocalDict[] = [];
  dict!: RhymeDict;
  private lastCopyAt = 0;
  // после двойного Ctrl+C, пока Ctrl не отпущен, стрелки ←/→ листают разделы панели
  private navArmed = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.dict = new RhymeDict(this.app, this.manifest.dir ?? "");
    this.dict.setLocalManifest(this.localDicts.map((d) => ({ id: d.id, name: d.name, enabled: d.enabled })));

    this.registerView(VIEW_TYPE_RHYMES, (leaf) => new RhymesView(leaf, this));

    this.addRibbonIcon("feather", t("cmdOpen"), () => void this.activateView(null));

    this.addCommand({
      id: "open-panel",
      name: t("cmdOpen"),
      callback: () => void this.activateView(null),
    });
    this.addCommand({
      id: "find-rhymes",
      name: t("cmdFind"),
      callback: () => {
        const w = this.grabWord();
        if (w) void this.activateView(w);
      },
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const w = this.wordFromEditor(editor);
        if (!w) return;
        menu.addItem((item) =>
          item
            .setTitle(t("menuFind") + w + t("menuFindEnd"))
            .setIcon("feather")
            .onClick(() => void this.activateView(w))
        );
      })
    );

    // двойной Ctrl+C: первое нажатие копирует как обычно, второе в окне
    // doubleCopyMs открывает панель с выделенным словом. Пока Ctrl не отпущен
    // (или фокус в панели), Ctrl+←/→ листают разделы панели.
    this.registerDomEvent(
      document,
      "keydown",
      (e: KeyboardEvent) => {
        if (!e.ctrlKey && !e.metaKey) {
          this.navArmed = false; // Ctrl отпущен — снять «взвод» листания (страховка к keyup)
          return;
        }
        // Alt при зажатом Ctrl — следующий раздел (большой палец, рука на мышке)
        if (e.key === "Alt") {
          if (e.repeat) return;
          const view = this.getRhymesView();
          if (!view || !view.hasWord()) return;
          const focusInPanel = view.containerEl.contains(activeDocument.activeElement);
          if (!this.navArmed && !focusInPanel) return;
          e.preventDefault();
          e.stopPropagation();
          view.cycleTab(1);
          return;
        }
        if (e.shiftKey || e.altKey) return;
        if (e.code === "KeyC") {
          // после двойного Ctrl+C, пока Ctrl зажат, каждое следующее C листает разделы
          if (this.navArmed) {
            const view = this.getRhymesView();
            if (view && view.hasWord()) {
              e.preventDefault();
              e.stopPropagation();
              if (!e.repeat) view.cycleTab(1);
              return;
            }
          }
          // автоповтор при УДЕРЖАНИИ Ctrl+C — не второе нажатие (иначе панель
          // открывается сама собой); двойной клик — это два отдельных события
          if (e.repeat) return;
          const ms = this.settings.doubleCopyMs;
          if (!ms) return;
          const now = Date.now();
          if (now - this.lastCopyAt < ms) {
            this.lastCopyAt = 0;
            const w = this.grabWord();
            if (w) {
              this.navArmed = true;
              void this.activateView(w);
            }
          } else {
            this.lastCopyAt = now;
          }
          return;
        }
        if (e.code === "ArrowRight" || e.code === "ArrowLeft") {
          const view = this.getRhymesView();
          if (!view || !view.hasWord()) return;
          const focusInPanel = view.containerEl.contains(activeDocument.activeElement);
          if (!this.navArmed && !focusInPanel) return;
          e.preventDefault();
          e.stopPropagation();
          view.cycleTab(e.code === "ArrowRight" ? 1 : -1);
        }
      },
      { capture: true }
    );
    // capture, чтобы сброс сработал, даже если keyup «съедят» до document
    this.registerDomEvent(
      document,
      "keyup",
      (e: KeyboardEvent) => {
        if (e.key === "Control" || e.key === "Meta") this.navArmed = false;
      },
      { capture: true }
    );
    // окно потеряло фокус с зажатым Ctrl — keyup уже не придёт; без сброса
    // следующий одиночный Ctrl+C листал бы разделы вместо копирования
    this.registerDomEvent(window, "blur", () => {
      this.navArmed = false;
    });

    this.addSettingTab(new RhymesSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      void this.ensureViewInSidebar(false);
      // на десктопе греем словарь заранее; на мобильном — лениво, при первом запросе
      if (!Platform.isMobile) void this.dict.load();
    });
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as (PersistedData & Partial<RhymesSettings>) | null;
    if (data && data.settings) {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
      this.userStress = data.userStress ?? {};
      // словари, добавленные до появления тумблера, считаем включёнными
      this.localDicts = Array.isArray(data.localDicts)
        ? data.localDicts.map((d) => ({ ...d, enabled: d.enabled !== false }))
        : [];
    } else {
      // старый плоский формат data.json
      this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
    }
    // миграция с прежнего тумблера «редкие»
    const legacy = (this.settings as unknown as { showRare?: boolean }).showRare;
    if (!Array.isArray(this.settings.lexShow) || this.settings.lexShow.length !== 4) {
      this.settings.lexShow = [true, true, true, legacy === true];
    }
    delete (this.settings as unknown as { showRare?: boolean }).showRare;
    // настройка «результатов на страницу» убрана — выдача фиксированно по 50 (см. PAGE в view.ts)
    delete (this.settings as unknown as { pageSize?: number }).pageSize;
  }
  async saveSettings(): Promise<void> {
    const data: PersistedData = { settings: this.settings, userStress: this.userStress, localDicts: this.localDicts };
    await this.saveData(data);
  }

  /** Запомненное пользователем ударение слова. */
  getUserStress(word: string): number | undefined {
    return this.userStress[word];
  }
  setUserStress(word: string, s: number | null): void {
    if (s === null) delete this.userStress[word];
    else this.userStress[word] = s;
    void this.saveSettings();
  }

  /** Слово из выделения/под курсором активного редактора, иначе из window-выделения. */
  private grabWord(): string | null {
    const mv = this.app.workspace.getActiveViewOfType(MarkdownView);
    let raw = "";
    if (mv) raw = this.rawFromEditor(mv.editor);
    if (!raw) raw = activeWindow.getSelection()?.toString() ?? "";
    return this.extractWord(raw);
  }

  private wordFromEditor(editor: Editor): string | null {
    return this.extractWord(this.rawFromEditor(editor));
  }

  private rawFromEditor(editor: Editor): string {
    const sel = editor.getSelection();
    if (sel) return sel;
    const range = editor.wordAt(editor.getCursor());
    return range ? editor.getRange(range.from, range.to) : "";
  }

  private extractWord(raw: string): string | null {
    // из выделенной фразы берём ПОСЛЕДНЕЕ слово (рифмуем конец строки, а не начало)
    const ws = raw.toLowerCase().match(/[а-яё]+(?:-[а-яё]+)*/g);
    return ws && ws.length ? ws[ws.length - 1] : null;
  }

  private getRhymesView(): RhymesView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_RHYMES)[0];
    return leaf && leaf.view instanceof RhymesView ? leaf.view : null;
  }

  /** Перерисовать открытую панель (после подключения/очистки личного словаря). */
  refreshPanel(): void {
    this.getRhymesView()?.refresh();
  }

  /** Вкладка панели всегда существует в правом сайдбаре (урок мобильной версии Songwriter). */
  private async ensureViewInSidebar(reveal: boolean): Promise<WorkspaceLeaf | null> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_RHYMES);
    let leaf: WorkspaceLeaf | null = existing[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) return null;
      await leaf.setViewState({ type: VIEW_TYPE_RHYMES, active: false });
    }
    if (reveal) await this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  async activateView(word: string | null): Promise<void> {
    const leaf = await this.ensureViewInSidebar(true);
    if (!leaf) return;
    if (leaf.isDeferred) await leaf.loadIfDeferred();
    if (!(leaf.view instanceof RhymesView)) return;
    if (word) await leaf.view.showWord(word);
    else leaf.view.focusSearch(); // открыли панель без слова — курсор сразу в поле поиска
  }

  /**
   * Скачать словарь с настроенного URL (для мобильного/новой установки, где папки
   * dict/ нет). onProgress — индикатор; возвращает true, если после загрузки словарь готов.
   */
  async downloadDict(onProgress: (done: number, total: number, name: string) => void): Promise<boolean> {
    try {
      await this.dict.downloadDict(this.settings.dictUrl, onProgress);
      await this.dict.reloadAfterDownload();
      return this.dict.status === "ready";
    } catch (e) {
      console.error("Russian Rhymes: dict download failed", e);
      return false;
    }
  }
}

class RhymesSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: RussianRhymesPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName(t("settingDouble"))
      .setDesc(t("settingDoubleDesc"))
      .addText((text) => {
        text.inputEl.type = "number";
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.doubleCopyMs))
          .setValue(String(this.plugin.settings.doubleCopyMs))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            this.plugin.settings.doubleCopyMs = Number.isFinite(n) && n >= 0 ? Math.min(n, 2000) : DEFAULT_SETTINGS.doubleCopyMs;
            await this.plugin.saveSettings();
          });
      });

    // скачивание словаря: для мобильного/новой установки, где нет папки dict/
    new Setting(containerEl).setName(t("dlHeading")).setHeading();
    new Setting(containerEl)
      .setName(t("settingUrl"))
      .setDesc(t("settingUrlDesc"))
      .addText((text) =>
        text.setValue(this.plugin.settings.dictUrl).onChange(async (v) => {
          this.plugin.settings.dictUrl = v.trim();
          await this.plugin.saveSettings();
        })
      );
    new Setting(containerEl)
      .setName(t("dlDict"))
      .setDesc(t("dlDesc"))
      .addButton((btn) => {
        btn.setButtonText(t("dlBtn")).setCta();
        btn.onClick(async () => {
          btn.setDisabled(true);
          const notice = new Notice(t("dlProgress"), 0);
          const ok = await this.plugin.downloadDict((done, total) => notice.setMessage(`${t("dlProgress")} ${done}/${total}`));
          notice.hide();
          new Notice(ok ? t("dlDone") : t("dlFailed"));
          btn.setDisabled(false);
          this.plugin.refreshPanel();
        });
      });

    // личные толковые словари из DSL-файлов (Lingvo/GoldenDict)
    new Setting(containerEl).setName(t("locHeading")).setHeading();
    this.renderDefsSection(containerEl);
  }

  private renderDefsSection(containerEl: HTMLElement): void {
    const dicts = this.plugin.localDicts;
    const setting = new Setting(containerEl)
      .setName(t("locDefs"))
      .setDesc(dicts.length ? t("locReorderHint") : t("locEmpty"));
    // Кнопка — это <label> с настоящим <input type=file> внутри. Диалог открывает
    // сам браузер по нативному клику по лейблу: без showPicker()/.click() и без
    // завязки на transient activation (из-за неё окно не появлялось сразу после
    // запуска Obsidian, пока не откроешь заметку).
    const label = setting.controlEl.createEl("label", { cls: "rr-add-btn", text: t("btnAddDsl") });
    const fileInput = label.createEl("input", {
      cls: "rr-file-hidden",
      attr: { type: "file", accept: ".dsl,.dz", multiple: "true" },
    });
    fileInput.addEventListener("change", () => {
      const files = fileInput.files ? Array.from(fileInput.files) : [];
      fileInput.value = ""; // сброс — иначе повторный выбор того же файла не даст change
      if (files.length) void this.importFiles(files);
    });
    if (!dicts.length) return;
    const listEl = containerEl.createDiv({ cls: "rr-dictlist" });
    this.fillDictList(listEl, dicts);
  }

  /** Список личных словарей: строки с ручкой перетаскивания, именем, счётчиком и удалением. */
  private fillDictList(listEl: HTMLElement, dicts: LocalDict[]): void {
    let dragId: string | null = null;
    for (const d of dicts) {
      const row = listEl.createDiv({ cls: "rr-dictrow" });
      row.dataset.id = d.id;
      if (!d.enabled) row.addClass("is-off");

      // тащим только за ручку — иначе нельзя выделить текст в поле имени
      const grip = row.createSpan({ cls: "rr-dictgrip", attr: { "aria-label": t("locReorderHint") } });
      setIcon(grip, "grip-vertical");
      grip.addEventListener("mousedown", () => row.setAttr("draggable", "true"));

      const nameInput = row.createEl("input", { cls: "rr-dictname", attr: { type: "text", spellcheck: "false" } });
      nameInput.value = d.name;
      nameInput.addEventListener("mousedown", () => row.setAttr("draggable", "false"));
      nameInput.addEventListener("change", () => {
        d.name = nameInput.value.trim() || d.name;
        nameInput.value = d.name;
        this.plugin.dict.renameDict(d.id, d.name);
        void this.plugin.saveSettings();
        this.plugin.refreshPanel();
      });

      row.createSpan({ cls: "rr-dictwords", text: `${d.words}${t("locWords")}` });

      // тумблер видимости: словарь остаётся, но выключенный не участвует в «Значении»
      const toggle = new ToggleComponent(row);
      toggle.toggleEl.addClass("rr-dicttoggle");
      toggle.setTooltip(t("locToggleHint"));
      toggle.setValue(d.enabled).onChange((v) => {
        d.enabled = v;
        row.toggleClass("is-off", !v);
        this.plugin.dict.setEnabled(d.id, v);
        void this.plugin.saveSettings();
        this.plugin.refreshPanel();
      });

      const del = row.createSpan({ cls: "rr-dictdel", attr: { "aria-label": t("btnClear") } });
      setIcon(del, "trash");
      del.addEventListener("click", async () => {
        await this.plugin.dict.deleteDict(d.id);
        this.plugin.localDicts = this.plugin.localDicts.filter((x) => x.id !== d.id);
        await this.plugin.saveSettings();
        this.plugin.refreshPanel();
        this.display();
      });

      row.addEventListener("dragstart", (e) => {
        dragId = d.id;
        row.addClass("is-dragging");
        e.dataTransfer?.setData("text/plain", d.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragend", () => {
        row.removeClass("is-dragging");
        row.setAttr("draggable", "false");
      });
      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        row.addClass("is-drop");
      });
      row.addEventListener("dragleave", () => row.removeClass("is-drop"));
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        row.removeClass("is-drop");
        if (dragId && dragId !== d.id) void this.moveDict(dragId, d.id);
        dragId = null;
      });
    }
  }

  /** Перенести словарь fromId на место перед targetId и сохранить порядок. */
  private async moveDict(fromId: string, targetId: string): Promise<void> {
    const ids = this.plugin.localDicts.map((d) => d.id);
    const fi = ids.indexOf(fromId);
    if (fi < 0) return;
    ids.splice(fi, 1);
    const ti = ids.indexOf(targetId);
    ids.splice(ti < 0 ? ids.length : ti, 0, fromId);
    const byId = new Map(this.plugin.localDicts.map((d) => [d.id, d]));
    this.plugin.localDicts = ids.map((id) => byId.get(id)).filter((d): d is LocalDict => !!d);
    this.plugin.dict.setOrder(ids);
    await this.plugin.saveSettings();
    this.plugin.refreshPanel();
    this.display();
  }

  private async importFiles(files: File[]): Promise<void> {
    new Notice(t("noticeConverting"));
    await new Promise((r) => setTimeout(r, 30)); // дать Notice отрисоваться
    let ok = 0;
    for (const file of files) {
      try {
        const conv = convertDsl(await file.arrayBuffer(), "definitions");
        if (conv.entries.size === 0) continue;
        const id = "ld" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
        const base = file.name.replace(/\.(dsl\.dz|dsl|dz)$/i, "");
        const name = conv.name && conv.name !== "DSL" ? conv.name : base;
        const words = await this.plugin.dict.importDict(id, name, conv.entries);
        this.plugin.localDicts.push({ id, name, words, enabled: true });
        // фиксируем манифест сразу после записи файла — чтобы краш между импортом
        // и общим saveSettings не оставил осиротевший невидимый local-*.txt.gz
        await this.plugin.saveSettings();
        ok++;
      } catch (e) {
        console.error("Russian Rhymes: DSL import failed", file.name, e);
      }
    }
    if (ok === 0) {
      new Notice(t("noticeBadDsl"));
      return;
    }
    await this.plugin.saveSettings();
    this.plugin.refreshPanel();
    this.display();
  }
}
