import { escapeHtml } from "../../core/utils.js";
import { openPopover } from "./popover.js";

const FALLBACK_SETTLE_MS = 180;

export function selectMarkup(options) {
  var selected = options.options.find(function(option) { return option.value === options.value; }) || options.options[0];
  return '<button id="' + escapeHtml(options.id) + '" class="' + escapeHtml(options.className || "settings-select") + '" type="button" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="' + escapeHtml(options.labelledBy + " " + options.id + "-value") + '" data-value="' + escapeHtml(selected?.value || "") + '">' +
    '<span id="' + escapeHtml(options.id + "-value") + '">' + escapeHtml(selected?.label || "") + '</span>' + (options.iconHtml || "") + '</button>';
}

export function wireSelect(root, options) {
  var trigger = root?.querySelector("#" + options.id), surface = null, popover = null, settleTimer = 0, disposeSettle = null;
  if (!trigger) return { trigger: null, close: function() {} };

  function selectedIndex() {
    var index = options.options.findIndex(function(option) { return option.value === trigger.dataset.value; });
    return index < 0 ? 0 : index;
  }
  function focusIndex(index) {
    var items = Array.from(surface?.querySelectorAll('[role="option"]') || []);
    if (!items.length) return;
    index = Math.max(0, Math.min(items.length - 1, index));
    items.forEach(function(item, itemIndex) { item.tabIndex = itemIndex === index ? 0 : -1; });
    items[index].focus({ preventScroll: true });
  }
  function close(settings) {
    if (!surface) return;
    var oldSurface = surface;
    surface = null;
    disposeSettle?.();
    disposeSettle = null;
    window.clearTimeout(settleTimer);
    popover?.close(settings);
    popover = null;
    oldSurface.remove();
  }
  function commit(index) {
    var option = options.options[index];
    if (!option) return;
    var changed = option.value !== trigger.dataset.value;
    trigger.dataset.value = option.value;
    trigger.querySelector("#" + options.id + "-value").textContent = option.label;
    close();
    if (changed) options.onChange?.(option.value, option);
  }
  function open(initialIndex) {
    if (surface) { focusIndex(initialIndex); return; }
    var listboxId = options.id + "-listbox";
    surface = document.createElement("div");
    surface.id = listboxId;
    surface.className = options.surfaceClassName || "select-listbox popover-surface";
    surface.setAttribute("role", "listbox");
    surface.setAttribute("aria-labelledby", options.labelledBy);
    surface.innerHTML = options.options.map(function(option, index) {
      var selected = option.value === trigger.dataset.value;
      return '<div id="' + escapeHtml(options.id + "-option-" + index) + '" class="select-option" role="option" aria-selected="' + (selected ? "true" : "false") + '" tabindex="' + (index === initialIndex ? "0" : "-1") + '" data-index="' + index + '">' + escapeHtml(option.label) + '</div>';
    }).join("");
    document.body.appendChild(surface);
    trigger.setAttribute("aria-controls", listboxId);
    surface.addEventListener("keydown", function(event) {
      var current = Number(document.activeElement?.dataset?.index);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault(); focusIndex(current + (event.key === "ArrowDown" ? 1 : -1));
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault(); focusIndex(event.key === "Home" ? 0 : options.options.length - 1);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault(); commit(current);
      }
    });
    surface.addEventListener("click", function(event) {
      var item = event.target.closest('[role="option"]');
      if (item) commit(Number(item.dataset.index));
    });
    popover = openPopover({ trigger: trigger, surface: surface, placement: options.placement || "bottom-end",
      initialFocus: surface.querySelector('[tabindex="0"]'), onClose: function() { close(); } });
    var disposed = false, openedSurface = surface;
    disposeSettle = function() { disposed = true; };
    if (typeof trigger.getAnimations !== "function") {
      settleTimer = window.setTimeout(function() {
        if (!disposed && surface === openedSurface) popover?.update();
      }, FALLBACK_SETTLE_MS);
    } else {
      var animations = [];
      for (var scope = trigger; scope; scope = scope.parentElement) {
        var scopeAnimations = scope.getAnimations?.({ subtree: false }) || [];
        if (scopeAnimations.length) {
          animations = scopeAnimations;
          break;
        }
      }
      Promise.allSettled(animations.map(function(animation) { return animation.finished; })).then(function() {
        if (!disposed && surface === openedSurface) popover?.update();
      });
    }
  }

  trigger.addEventListener("keydown", function(event) {
    if (!["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    var index = selectedIndex();
    if (event.key === "ArrowDown") index = Math.min(options.options.length - 1, index + 1);
    if (event.key === "ArrowUp") index = Math.max(0, index - 1);
    open(index);
  });
  trigger.addEventListener("click", function() { surface ? close() : open(selectedIndex()); });
  return { trigger: trigger, close: close };
}
