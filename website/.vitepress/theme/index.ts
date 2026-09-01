import DefaultTheme from "vitepress/theme";
import Layout from "./Layout.vue";
import ReactReliabilityDemo from "./components/ReactReliabilityDemo.vue";
import SyncDemo from "./components/SyncDemo.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component("ReactReliabilityDemo", ReactReliabilityDemo);
    app.component("SyncDemo", SyncDemo);
  },
};
