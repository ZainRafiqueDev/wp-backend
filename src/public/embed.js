(function () {
  "use strict";

  var script = document.currentScript;
  var chatbotId = script.getAttribute("data-chatbot-id");
  var widgetBase = script.getAttribute("data-widget-base");

  if (!chatbotId) {
    console.error("[chatmate360] embed.js: missing required data-chatbot-id attribute on the <script> tag");
    return;
  }
  if (!widgetBase) {
    console.error("[chatmate360] embed.js: missing required data-widget-base attribute (the URL your Chatmate360 dashboard is hosted at)");
    return;
  }

 
  var apiBase = new URL(script.src).origin;


  var primaryColor = script.getAttribute("data-primary-color") || "#769656";
  var bgColor = script.getAttribute("data-bg-color") || "#ffffff";
  var textColor = script.getAttribute("data-text-color") || "#1f2937";

  var BUBBLE_SIZE = 60;

  var bubble = document.createElement("button");
  bubble.type = "button";
  bubble.setAttribute("aria-label", "Open chat");
  bubble.style.cssText = [
    "position:fixed", "bottom:20px", "right:20px",
    "width:" + BUBBLE_SIZE + "px", "height:" + BUBBLE_SIZE + "px",
    "border-radius:50%", "border:none", "background:" + primaryColor, "color:#fff",
    "font-size:24px", "line-height:" + BUBBLE_SIZE + "px", "cursor:pointer",
    "box-shadow:0 4px 14px rgba(0,0,0,.25)", "z-index:2147483000",
    "transition:transform .2s ease", "transform:scale(1)",
  ].join(";");
  bubble.addEventListener("mouseenter", function () {
    bubble.style.transform = "scale(1.08)";
  });
  bubble.addEventListener("mouseleave", function () {
    bubble.style.transform = "scale(1)";
  });

  var iconSpan = document.createElement("span");
  iconSpan.style.cssText = "display:inline-block;transition:transform .2s ease";
  iconSpan.textContent = "💬";
  bubble.appendChild(iconSpan);

  var parentOrigin = window.location.origin;

  var frame = document.createElement("iframe");
  frame.title = "Chatmate360 widget";
  frame.src = widgetBase.replace(/\/$/, "") + "/widget/" + encodeURIComponent(chatbotId) +
    "?apiBase=" + encodeURIComponent(apiBase) +
    "&parentOrigin=" + encodeURIComponent(parentOrigin) +
    "&primaryColor=" + encodeURIComponent(primaryColor) +
    "&bgColor=" + encodeURIComponent(bgColor) +
    "&textColor=" + encodeURIComponent(textColor);
  frame.setAttribute("allow", "clipboard-write");
  frame.style.cssText = [
    "position:fixed", "bottom:90px", "right:20px",
    "width:380px", "height:600px",
    "max-width:calc(100vw - 40px)", "max-height:calc(100vh - 110px)",
    "border:none", "border-radius:16px", "box-shadow:0 12px 40px rgba(0,0,0,.25)",
    "z-index:2147483000", "background:#fff", "transform-origin:bottom right",
    "transition:opacity .18s ease, transform .18s ease", "opacity:0",
    "transform:scale(0.9) translateY(8px)", "visibility:hidden", "pointer-events:none",
  ].join(";");

  var open = false;
  function toggle() {
    open = !open;
    if (open) {
      frame.style.visibility = "visible";
      frame.style.pointerEvents = "auto";
      
      void frame.offsetHeight;
    }
    frame.style.opacity = open ? "1" : "0";
    frame.style.transform = open ? "scale(1) translateY(0)" : "scale(0.9) translateY(8px)";
    if (!open) {
      window.setTimeout(function () {
        if (!open) {
          frame.style.visibility = "hidden";
          frame.style.pointerEvents = "none";
        }
      }, 180);
    }
    iconSpan.style.transform = open ? "rotate(90deg)" : "rotate(0deg)";
    iconSpan.textContent = open ? "✕" : "💬";
    bubble.setAttribute("aria-label", open ? "Close chat" : "Open chat");
  }
  bubble.addEventListener("click", toggle);

  function mount() {
    document.body.appendChild(frame);
    document.body.appendChild(bubble);
  }
  if (document.body) {
    mount();
  } else {
    document.addEventListener("DOMContentLoaded", mount);
  }
})();
