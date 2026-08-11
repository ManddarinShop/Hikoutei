import DefaultTheme from "vitepress/theme";
import Layout from "./Layout.vue";
import SyncDemo from "./components/SyncDemo.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component("SyncDemo", SyncDemo);
  },
};
