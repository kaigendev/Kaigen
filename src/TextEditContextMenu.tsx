import { useEffect } from "react";
import { isEditableTextTarget } from "./editableTextTarget";

export default function TextEditContextMenu() {
  useEffect(() => {
    const suppressNonEditableContextMenu = (event: MouseEvent) => {
      // Only the browser/WebView can paste without a second clipboard
      // permission affordance. Editable controls therefore keep their single
      // native menu; Kaigen still suppresses the generic menu elsewhere.
      if (isEditableTextTarget(event.target)) return;
      event.preventDefault();
    };
    document.addEventListener("contextmenu", suppressNonEditableContextMenu);
    return () => {
      document.removeEventListener("contextmenu", suppressNonEditableContextMenu);
    };
  }, []);

  return null;
}
