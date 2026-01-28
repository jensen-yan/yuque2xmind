import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import inquirer from "inquirer";
import { SingleBar } from "cli-progress";
import Table from "cli-table3";
import pLimit from "p-limit";
import { createLogger, format, transports } from "winston";
import JSZip from "jszip";

// 设置日志记录器
const logger = createLogger({
  level: "info",
  format: format.combine(
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    format.errors({ stack: true }),
    format.splat(),
    format.json()
  ),
  defaultMeta: { service: "xmind-to-markdown-service" },
  transports: [
    new transports.File({ filename: "error.log", level: "error" }),
    new transports.File({ filename: "combined.log" }),
    new transports.Console({
      format: format.combine(format.colorize(), format.simple()),
    }),
  ],
});

// 获取当前文件的文件名和目录名
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 递归遍历目录，收集符合要求的文件
const collectXmindFiles = (dir, files = []) => {
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      collectXmindFiles(fullPath, files);
    } else if (stat.isFile() && path.extname(item) === ".xmind") {
      files.push(fullPath);
    }
  }
  return files;
};

/**
 * 从 XMind 文件中读取 content.json
 * @param {string} xmindPath - XMind 文件路径
 * @returns {Promise<Object>} - 解析后的 JSON 内容
 */
async function readXmindContent(xmindPath) {
  const data = fs.readFileSync(xmindPath);
  const zip = await JSZip.loadAsync(data);
  const contentFile = zip.file("content.json");
  if (!contentFile) {
    throw new Error("XMind 文件中未找到 content.json");
  }
  const contentJson = await contentFile.async("string");
  return JSON.parse(contentJson);
}

/**
 * 获取节点的标题文本
 * @param {Object} node - XMind 节点
 * @returns {string} - 标题文本
 */
function getNodeTitle(node) {
  if (!node) return "";
  if (typeof node.title === "string") {
    return node.title;
  }
  return "";
}

/**
 * 递归将 XMind 节点转换为 Markdown
 * @param {Object} node - XMind 节点
 * @param {number} level - 当前层级（用于标题级别或缩进）
 * @param {string} mode - 转换模式: "heading" 使用标题, "list" 使用列表
 * @returns {string} - Markdown 字符串
 */
function nodeToMarkdown(node, level = 1, mode = "heading") {
  if (!node) return "";

  const title = getNodeTitle(node);
  let md = "";

  if (mode === "heading") {
    // 使用标题模式（最多支持6级标题）
    const headingLevel = Math.min(level, 6);
    md += `${"#".repeat(headingLevel)} ${title}\n\n`;
  } else {
    // 使用列表模式
    const indent = "  ".repeat(Math.max(0, level - 1));
    md += `${indent}- ${title}\n`;
  }

  // 处理子节点
  const children = node.children?.attached || [];
  for (const child of children) {
    md += nodeToMarkdown(child, level + 1, mode);
  }

  return md;
}

/**
 * 将 XMind 内容转换为 Markdown
 * @param {Object} content - XMind content.json 的内容
 * @param {string} mode - 转换模式: "heading" 或 "list"
 * @returns {string} - Markdown 字符串
 */
function xmindToMarkdown(content, mode = "heading") {
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error("无效的 XMind 内容格式");
  }

  let markdown = "";

  // 处理每个 sheet（XMind 可能有多个画布）
  for (let i = 0; i < content.length; i++) {
    const sheet = content[i];
    const rootTopic = sheet.rootTopic;

    if (i > 0) {
      markdown += "\n---\n\n"; // 多个 sheet 之间用分隔线
    }

    if (sheet.title && content.length > 1) {
      markdown += `# ${sheet.title}\n\n`;
      markdown += nodeToMarkdown(rootTopic, 2, mode);
    } else {
      markdown += nodeToMarkdown(rootTopic, 1, mode);
    }
  }

  return markdown;
}

/**
 * 转换单个 XMind 文件为 Markdown
 * @param {string} xmindPath - XMind 文件路径
 * @param {string} outputPath - 输出 Markdown 文件路径
 * @param {string} mode - 转换模式
 */
async function convertXmindFile(xmindPath, outputPath, mode = "heading") {
  const content = await readXmindContent(xmindPath);
  const markdown = xmindToMarkdown(content, mode);

  // 确保输出目录存在
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, markdown, "utf-8");
}

// 主程序
const prompt = inquirer.createPromptModule();
const errorMsgList = [];

prompt([
  {
    type: "input",
    name: "dirPath",
    message: "请输入要处理的目录路径:",
    default: path.resolve(__dirname, "..", "result", "output"),
    validate(answer) {
      if (!fs.existsSync(answer) || !fs.statSync(answer).isDirectory()) {
        return "请输入一个有效的目录路径。";
      }
      return true;
    },
  },
])
  .then(async (answers) => {
    const rootDir = answers.dirPath;

    // 收集所有符合要求的文件
    const xmindFiles = collectXmindFiles(rootDir);

    if (xmindFiles.length === 0) {
      logger.info("目录中不存在 .xmind 文件。");
      return;
    }

    // 构建供选择的文件列表，并加入全选选项
    const choices = [
      { name: "全选", value: "all" },
      ...xmindFiles.map((file) => ({
        name: path.relative(rootDir, file),
        value: file,
        checked: false,
      })),
    ];

    // 提示用户选择文件
    const promptFiles = inquirer.createPromptModule();
    promptFiles([
      {
        type: "checkbox",
        name: "selectedFiles",
        message: "请选择要处理的文件（按空格勾选，Enter确认）:",
        choices: choices,
        validate(answer) {
          if (answer.length < 1) {
            return "你必须至少选择一个文件。";
          }
          return true;
        },
        filter(answer) {
          if (answer.includes("all")) {
            return choices.map((choice) => choice.value);
          }
          return answer;
        },
      },
      {
        type: "list",
        name: "mode",
        message: "请选择转换模式:",
        choices: [
          { name: "标题模式 (使用 # 标题层级)", value: "heading" },
          { name: "列表模式 (使用 - 缩进列表)", value: "list" },
        ],
        default: "heading",
      },
    ])
      .then(async (answers) => {
        const selectedFiles = answers.selectedFiles.filter(
          (file) => file !== "all"
        );
        const mode = answers.mode;

        // 使用 cli-progress 创建总进度条
        const totalProgressBar = new SingleBar({
          format: "{bar} {percentage}% | ETA: {eta}s | {value}/{total} Files",
          barCompleteChar: "\u2588",
          barIncompleteChar: "\u2591",
          hideCursor: true,
        });

        totalProgressBar.start(selectedFiles.length, 0);

        // 使用 cli-table3 创建表格
        const table = new Table({
          head: [
            { content: "文件名称", hAlign: "center", style: { head: ["green"] } },
            { content: "原文件大小 (bytes)", hAlign: "center", style: { head: ["green"] } },
            { content: "处理时长 (ms)", hAlign: "center", style: { head: ["green"] } },
            { content: "保存路径", hAlign: "center", style: { head: ["green"] } },
            { content: "结果", hAlign: "center", style: { head: ["green"] } },
          ],
          colWidths: [30, 20, 20, 60, 20],
        });

        // 设置并发限制
        const limit = pLimit(5);

        // 处理每个文件的函数
        const processFile = async (file) => {
          const fileName = path.basename(file, ".xmind");
          const saveDir = path.join(
            __dirname,
            "..",
            "result",
            "markdown",
            `${fileName}.md`
          );
          const rowData = [fileName, "-", "-", saveDir, "处理中"];
          const startTime = Date.now();

          try {
            const stat = fs.statSync(file);
            const fileSize = stat.size;

            await convertXmindFile(file, saveDir, mode);

            const endTime = Date.now();
            const elapsedTime = endTime - startTime;
            rowData[4] = "已完成";
            rowData[2] = elapsedTime.toString();
            rowData[1] = fileSize.toString();
          } catch (error) {
            const msg = `处理文件 ${file} 时发生错误: ${error.message}`;
            errorMsgList.push(msg);
            rowData[4] = "失败";
          }

          table.push(rowData);
          totalProgressBar.increment();
        };

        // 使用 p-limit 进行并发控制
        const promises = selectedFiles.map((file) =>
          limit(() => processFile(file))
        );

        // 等待所有文件处理完成
        await Promise.all(promises);

        // 结束总进度条
        totalProgressBar.stop();

        // 如果存在错误信息，输出错误信息
        if (errorMsgList.length > 0) {
          errorMsgList.forEach((msg) => {
            logger.error("异常日志: %s", msg);
          });
        }

        // 输出表格
        console.log(table.toString());
      })
      .catch((err) => {
        logger.error("选择文件时发生错误: %s", err);
      });
  })
  .catch((err) => {
    logger.error("输入目录路径时发生错误: %s", err);
  });
