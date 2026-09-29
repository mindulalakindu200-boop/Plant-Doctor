  // Logging Helper Function
        function logMessage(level, context, message, details = null) {
            const timestamp = new Date().toISOString();
            const logEntry = `[${timestamp}] [${level.toUpperCase()}] [${context}] ${message}`;
            if (details !== null) {
                console[level](logEntry, details);
            } else {
                console[level](logEntry);
            }
        }

        // ============================================================
        // NEW: VALIDATION SETTINGS
        // ============================================================
        const PLANT_PIXEL_THRESHOLD = 0.10;        // Min % of plant-colored pixels needed
        const MODEL_CONFIDENCE_THRESHOLD = 0.60;   // Model must be at least 60% sure
        const NON_PLANT_CLASS_THRESHOLD = 0.50;    // Reject if "Not a Plant" class >= 50%
        const VALID_IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "bmp", "gif"];
        // ============================================================

        // Global State Variables
        let model = null;
        let isCustomModelLoaded = false;
        let maxPredictions = 0;
        let diseaseKnowledgebase = [];

        async function loadDiseaseKnowledgebase() {
            logMessage("info", "Knowledgebase", "Fetching diseases.json...");
            try {
                const response = await fetch("diseases.json");
                if (!response.ok) {
                    throw new Error(`HTTP error! Status: ${response.status}`);
                }
                const data = await response.json();
                diseaseKnowledgebase = data.diseases || [];
                logMessage("info", "Knowledgebase", `Loaded ${diseaseKnowledgebase.length} disease definitions successfully.`);
            } catch(error) {
                logMessage("error", "Knowledgebase", "Failed to load disease definitions from diseases.json", error);
            }
        }

        const demoSamples = {
            healthy: {
                predictions: [
                    { className: "Healthy Leaf", probability: 0.96 },
                    { className: "Leaf Rust", probability: 0.03 },
                    { className: "Early Blight", probability: 0.01 },
                    { className: "Leaf Virus", probability: 0.02 },
                    { className: "Insect Mites", probability: 0.01 },
                    { className: "Bavterial Spot", probability: 0.01 }
                ]
            },
            blight: {
                predictions: [
                    { className: "Early Blight", probability: 0.88 },
                    { className: "Leaf Rust", probability: 0.09 },
                    { className: "Healthy Leaf", probability: 0.03 },
                    { className: "Leaf Virus", probability: 0.02 },
                    { className: "Insect Mites", probability: 0.01 },
                    { className: "Bavterial Spot", probability: 0.01 }  
                ]
            },
            rust: {
                predictions: [
                    { className: "Leaf Rust", probability: 0.91 },
                    { className: "Early Blight", probability: 0.07 },
                    { className: "Healthy Leaf", probability: 0.02 },
                    { className: "Leaf Virus", probability: 0.02 },
                    { className: "Insect Mites", probability: 0.01 },
                    { className: "Bavterial Spot", probability: 0.01 }  
                ]
            }
        };

        const dropZone = document.getElementById('drop-zone');
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, preventDefaults, false);
        });

        function preventDefaults(e) {
            e.preventDefault();
            e.stopPropagation();
        }

        ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => dropZone.classList.add('drop-zone--over'), false);
        });

        ['dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => dropZone.classList.remove('drop-zone--over'), false);
        });

        dropZone.addEventListener('drop', (e) => {
            logMessage("info", "Upload", "File dropped into dropzone.");
            const dt = e.dataTransfer;
            const files = dt.files;
            if (files.length > 0) {
                processImageFile(files[0]);
            }
        });

        function handleFileSelect(event) {
            logMessage("info", "Upload", "File selected via file dialog.");
            const file = event.target.files[0];
            if (file) {
                processImageFile(file);
            }
            event.target.value = ""; // Allow re-uploading the same file
        }

        // ============================================================
        // NEW & FIXED: File processing with strict validation
        // ============================================================
        function processImageFile(file) {
            if (!file) return;

            logMessage("info", "Upload", "Processing uploaded file...", { fileName: file.name, fileSize: file.size, fileType: file.type });

            // --- VALIDATION 1: Reject PDFs, documents & non-image files ---
            const extension = (file.name.split(".").pop() || "").toLowerCase();
            const isImageMime = file.type && file.type.startsWith("image/");
            const isImageExt = VALID_IMAGE_EXTENSIONS.includes(extension);

            if (file.size === 0 || !(isImageMime || isImageExt)) {
                logMessage("warn", "Upload", "Invalid file rejected (PDF / document / non-image).", { fileType: file.type, extension: extension });
                renderErrorCard(
                    "Cannot Identify This File",
                    `The file "<b>${file.name}</b>" is not a valid image${extension ? ` (detected .${extension})` : ""}. PDFs, documents and other non-image files cannot be diagnosed.<br><br>Please upload a clear photo of a <b>plant leaf</b> (PNG, JPG, JPEG or WEBP).`
                );
                showToast("Cannot identify this file. Please upload a plant leaf image.");
                return;
            }

            const imgElement = document.getElementById("image-preview");
            const placeholder = document.getElementById("preview-placeholder");

            const reader = new FileReader();

            reader.onload = function(e) {
                // --- VALIDATION 2: Catch fake images (e.g. PDF renamed to .jpg) ---
                imgElement.onload = async () => {
                    logMessage("info", "Upload", "Image successfully rendered in preview area.");
                    await runAnalysis(imgElement);
                };
                imgElement.onerror = () => {
                    logMessage("error", "Upload", "Image failed to decode — file is corrupted, fake, or not a real image.");
                    renderErrorCard(
                        "Cannot Identify This Image",
                        "This file could not be read as a real image. It may be a PDF, document, or corrupted file renamed as an image.<br><br>Please upload a genuine photo of a <b>plant leaf</b>."
                    );
                    showToast("Cannot identify this image. The file appears to be invalid.");
                };

                imgElement.src = e.target.result;
                imgElement.classList.remove("hidden");
                placeholder.classList.add("hidden");
            };

            reader.onerror = function() {
                logMessage("error", "Upload", "FileReader failed to read the file.");
                renderErrorCard(
                    "Cannot Read This File",
                    "The file could not be read. It may be corrupted or in an unsupported format.<br><br>Please upload a clear photo of a <b>plant leaf</b>."
                );
                showToast("Cannot read this file. Please try another image.");
            };

            reader.readAsDataURL(file);
        }

        function loadSample(type) {
            logMessage("info", "DemoSample", `Demo sample requested: ${type}`);
            const sample = demoSamples[type];
            if (!sample) {
                logMessage("warn", "DemoSample", `Sample type "${type}" not found.`);
                return;
            }

            const imgElement = document.getElementById("image-preview");
            const placeholder = document.getElementById("preview-placeholder");

            imgElement.crossOrigin = "anonymous";
            imgElement.src = sample.url || "#";
            imgElement.classList.remove("hidden");
            placeholder.classList.add("hidden");

            imgElement.onload = async () => {
                logMessage("info", "DemoSample", `Demo sample "${type}" image loaded.`);
                if (isCustomModelLoaded && model) {
                    logMessage("info", "DemoSample", "Custom model is active. Running live analysis on demo image...");
                    await runAnalysis(imgElement);
                } else {
                    logMessage("info", "DemoSample", "No custom model loaded. Displaying mock predictions.");
                    showLoading(true);
                    setTimeout(() => {
                        renderPredictions(sample.predictions);
                        showLoading(false);
                    }, 400);
                }
            };

            // FIX: If demo image file is missing, still show the stored mock predictions
            imgElement.onerror = () => {
                logMessage("warn", "DemoSample", `Demo image file for "${type}" not found. Showing stored predictions.`);
                showLoading(true);
                setTimeout(() => {
                    renderPredictions(sample.predictions);
                    showLoading(false);
                }, 300);
            };
        }

        async function loadCustomModel(url, modelName) {
            logMessage("info", "ModelLoader", `Initiating load for model "${modelName}" from ${url}`);
           
            if (!url) {
                logMessage("warn", "ModelLoader", "Model load aborted: URL is missing.");
                showToast("Please enter a valid Teachable Machine URL.");
                return;
            }

            if (!url.endsWith("/")) {
                url += "/";
            }

            const activeModelText = document.getElementById("active-model-text");
            const container = document.getElementById("result-container");
           
            showLoading(true);
            if (activeModelText) {
                activeModelText.innerHTML = `Active Model: <span class="font-bold text-amber-600">Loading ${modelName}...</span>`;
            }

            if (container) {
                container.innerHTML = `
                    <div class="text-center py-6 text-green-700 font-semibold text-xs flex flex-col items-center justify-center gap-2">
                        <i class="fa-solid fa-spinner animate-spin text-2xl"></i>
                        <span>Loading ${modelName} AI Model, please wait...</span>
                    </div>
                `;
            }

            try {
                const modelURL = url + "model.json";
                const metadataURL = url + "metadata.json";

                logMessage("info", "ModelLoader", "Downloading TensorFlow.js model files...", { modelURL, metadataURL });
                model = await tmImage.load(modelURL, metadataURL);
                maxPredictions = model.getTotalClasses();
                isCustomModelLoaded = true;

                logMessage("info", "ModelLoader", `Model "${modelName}" successfully initialized. Total classes: ${maxPredictions}`);

                if (activeModelText) {
                    activeModelText.innerHTML = `Active Model: <span class="font-bold text-green-700">${modelName}</span>`;
                }

                showToast(`${modelName} Model loaded successfully!`);
               
                if (container) {
                    container.innerHTML = `
                        <div class="text-center py-6 text-gray-400 text-xs">
                            ${modelName} Model loaded! Upload an image or select a demo sample to see AI prediction scores.
                        </div>
                    `;
                }

                const imgElement = document.getElementById("image-preview");
                if (!imgElement.classList.contains("hidden")) {
                    logMessage("info", "ModelLoader", "Re-analyzing active preview image with newly loaded model...");
                    await runAnalysis(imgElement);
                }
            } catch (error) {
                logMessage("error", "ModelLoader", `Failed to load model "${modelName}" from ${url}`, error);
                showToast("Failed to load model. Check URL or network.");
               
                if (activeModelText) {
                    activeModelText.innerHTML = `Active Model: <span class="font-bold text-red-600">Failed to load</span>`;
                }

                if (container) {
                    container.innerHTML = `
                        <div class="text-center py-6 text-red-500 text-xs font-medium">
                            Failed to load model. Please try again.
                        </div>
                    `;
                }
                isCustomModelLoaded = false;
            } finally {
                showLoading(false);
            }
        }

        // ============================================================
        // NEW: Pixel-based plant/leaf detector (green + diseased colors)
        // ============================================================
        function analyzePlantPixels(imgElement) {
            return new Promise((resolve) => {
                try {
                    const canvas = document.createElement("canvas");
                    const ctx = canvas.getContext("2d", { willReadFrequently: true });

                    const maxSide = 200;
                    const w = imgElement.naturalWidth || imgElement.width || maxSide;
                    const h = imgElement.naturalHeight || imgElement.height || maxSide;
                    const scale = Math.min(1, maxSide / Math.max(w, h));

                    canvas.width = Math.max(1, Math.round(w * scale));
                    canvas.height = Math.max(1, Math.round(h * scale));

                    ctx.drawImage(imgElement, 0, 0, canvas.width, canvas.height);
                    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    const data = imageData.data;

                    let greenPixels = 0;
                    let yellowBrownPixels = 0;
                    const totalPixels = data.length / 4;

                    for (let i = 0; i < data.length; i += 4) {
                        const r = data[i];
                        const g = data[i + 1];
                        const b = data[i + 2];

                        // Healthy green leaf pixels
                        if (g > r && g > b && g > 40) {
                            greenPixels++;
                        }
                        // Yellow / brown pixels (diseased leaves, blight, rust)
                        else if (r > 90 && g > 60 && b < g && b < r && (r - b) > 30) {
                            yellowBrownPixels++;
                        }
                    }

                    const greenRatio = greenPixels / totalPixels;
                    const yellowBrownRatio = yellowBrownPixels / totalPixels;

                    // Green = strong evidence, yellow/brown = weaker evidence
                    const plantScore = greenRatio + (yellowBrownRatio * 0.4);

                    logMessage("info", "PlantCheck", `green: ${(greenRatio * 100).toFixed(1)}% | yellow/brown: ${(yellowBrownRatio * 100).toFixed(1)}% | score: ${(plantScore * 100).toFixed(1)}% (threshold: ${(PLANT_PIXEL_THRESHOLD * 100)}%)`);

                    resolve({
                        isPlant: plantScore >= PLANT_PIXEL_THRESHOLD,
                        greenRatio,
                        yellowBrownRatio,
                        plantScore
                    });
                } catch (err) {
                    // If pixel reading fails (e.g. CORS), don't block the image — let the model decide
                    logMessage("warn", "PlantCheck", "Pixel analysis failed — passing image to model instead.", err);
                    resolve({ isPlant: true, greenRatio: -1, yellowBrownRatio: -1, plantScore: -1 });
                }
            });
        }

        // ============================================================
        // NEW: Detect a "Not a Plant" class if you train one in Teachable Machine
        // ============================================================
        function getNonPlantPrediction(predictions) {
            if (!predictions) return null;
            return predictions.find(p => {
                const n = (p.className || "").toLowerCase();
                return n.includes("not a plant") || n.includes("non-plant") ||
                       n.includes("nonplant") || n.includes("not plant") ||
                       n.includes("other") || n.includes("unknown");
            }) || null;
        }

        // ============================================================
        // FIXED: runAnalysis now validates plant BEFORE diagnosing
        // ============================================================
        async function runAnalysis(imageElement) {
            logMessage("info", "Analysis", "Starting image analysis...");
            showLoading(true);

            const container = document.getElementById("result-container");
            container.innerHTML = `
                <div class="text-center py-6 text-green-700 font-semibold text-xs flex flex-col items-center justify-center gap-2">
                    <i class="fa-solid fa-magnifying-glass-leaf animate-pulse text-2xl"></i>
                    <span>Verifying plant leaf & analyzing image...</span>
                </div>
            `;

            try {
                // ===== VALIDATION 3: Is this image even a plant? =====
                const plantCheck = await analyzePlantPixels(imageElement);

                if (!plantCheck.isPlant) {
                    logMessage("warn", "Analysis", "Plant check FAILED. Image does not look like a plant leaf.");
                    renderErrorCard(
                        "This is Not a Plant Leaf",
                        "The uploaded image does not appear to be a plant or leaf. <b>Plant Doctor</b> can only diagnose plant leaf photos.<br><br>Please try again with a clear photo of a plant leaf."
                    );
                    showToast("Not a plant leaf. Please upload a plant leaf image.");
                    showLoading(false);
                    return;
                }

                if (isCustomModelLoaded && model) {
                    logMessage("info", "Analysis", "Running prediction using Teachable Machine model...");
                    const predictions = await model.predict(imageElement);
                    logMessage("info", "Analysis", "Raw prediction output received:", predictions);

                    // ===== VALIDATION 4: "Not a Plant" class (if you trained one) =====
                    const nonPlant = getNonPlantPrediction(predictions);
                    if (nonPlant && nonPlant.probability >= NON_PLANT_CLASS_THRESHOLD) {
                        logMessage("warn", "Analysis", `Model classified image as "${nonPlant.className}" (${(nonPlant.probability * 100).toFixed(1)}%). Rejecting.`);
                        renderErrorCard(
                            "This is Not a Plant Leaf",
                            "The AI model detected that this image is <b>not a plant leaf</b>.<br><br>Please upload a clear photo of a plant leaf so I can diagnose it."
                        );
                        showToast("Not a plant leaf. Please upload a plant leaf image.");
                        showLoading(false);
                        return;
                    }

                    // ===== VALIDATION 5: Model confidence too low =====
                    const sorted = [...predictions].sort((a, b) => b.probability - a.probability);
                    if (sorted[0].probability < MODEL_CONFIDENCE_THRESHOLD) {
                        logMessage("warn", "Analysis", `Top confidence too low (${(sorted[0].probability * 100).toFixed(1)}%). Cannot identify.`);
                        renderErrorCard(
                            "Cannot Identify This Image",
                            `The AI is not confident enough about this image (best match: ${(sorted[0].probability * 100).toFixed(1)}%). It may not be a recognizable plant leaf.<br><br>Please upload a clear, close-up photo of a <b>plant leaf</b>.`
                        );
                        showToast("Cannot identify this image. Please try a clearer leaf photo.");
                        showLoading(false);
                        return;
                    }

                    renderPredictions(predictions);
                } else {
                    logMessage("info", "Analysis", "Custom model not loaded. Generating fallback mock predictions...");
                    setTimeout(() => {
                        const mockPredictions = [
                            { className: "Healthy Leaf", probability: 0.75 },
                            { className: "Leaf Rust", probability: 0.18 },
                            { className: "Early Blight", probability: 0.07 }
                        ];
                        logMessage("info", "Analysis", "Mock predictions generated:", mockPredictions);
                        renderPredictions(mockPredictions);
                        showLoading(false);
                    }, 500);
                    return;
                }
            } catch (err) {
                logMessage("error", "Analysis", "Prediction execution failed:", err);
                showToast("Error processing image preview.");
            }
            showLoading(false);
        }

        // ============================================================
        // NEW: Styled error card (red) matching the app design
        // ============================================================
        function renderErrorCard(title, message) {
            const container = document.getElementById("result-container");
            container.innerHTML = `
                <div class="bg-red-50 border border-red-200 p-4 rounded-xl shadow-sm mb-3">
                    <div class="flex items-center gap-2 mb-2">
                        <div class="w-8 h-8 rounded-full bg-red-100 text-red-600 flex items-center justify-center shrink-0">
                            <i class="fa-solid fa-triangle-exclamation"></i>
                        </div>
                        <span class="font-bold text-red-700 text-sm">${title}</span>
                    </div>
                    <p class="text-xs text-red-600 leading-relaxed">${message}</p>
                </div>
            `;
        }

        function renderPredictions(predictions) {
            const container = document.getElementById("result-container");
            container.innerHTML = "";

            if (!predictions || predictions.length === 0) {
                logMessage("warn", "UI", "renderPredictions called with empty or undefined predictions.");
                return;
            }

            // Sort predictions to locate the single highest match
            const sorted = [...predictions].sort((a, b) => b.probability - a.probability);
            const topPrediction = sorted[0];
            logMessage("info", "UI", `Top prediction selected: ${topPrediction.className} (${(topPrediction.probability * 100).toFixed(1)}%)`);

            const details = lookupDiseaseDetails(topPrediction.className);
            if (details) {
                logMessage("info", "UI", "Matched disease details from knowledgebase:", details);
            } else {
                logMessage("warn", "UI", `No matching knowledgebase entry found for class: "${topPrediction.className}"`);
            }

            const percent = (topPrediction.probability * 100).toFixed(1);
            const isHealthy = topPrediction.className.toLowerCase().includes("healthy");
            const colorClass = isHealthy ? "bg-green-600" : "bg-amber-600";

            // Render ONLY the single best match
            const wrapper = document.createElement("div");
            wrapper.className = "bg-white p-3 rounded-xl border border-gray-100 shadow-sm mb-3";

            wrapper.innerHTML = `
                <div class="flex justify-between items-center mb-1 text-xs">
                    <span class="font-bold text-gray-800">${topPrediction.className}</span>
                    <span class="font-mono text-[11px] font-bold text-green-700">${percent}%</span>
                </div>
                <div class="w-full bg-gray-100 h-2 rounded-full overflow-hidden">
                    <div class="progress-bar-fill h-full ${colorClass}" style="width: ${percent}%"></div>
                </div>
            `;
            container.appendChild(wrapper);

            // Render disease knowledge card if details exist
            if (details) {
                const infoCard = document.createElement("div");
                infoCard.className = "bg-white p-4 rounded-2xl border border-gray-200 shadow-sm text-xs text-gray-700 space-y-3 mb-3";
                infoCard.innerHTML = `
                    <div>
                        <span class="font-bold text-gray-900 block mb-1 flex items-center gap-1.5">
                            <i class="fa-solid fa-microscope text-emerald-700"></i>
                            <span>Cause</span>
                        </span>
                        <p class="text-gray-700 bg-gray-50 p-2 rounded-lg border border-gray-100 font-mono text-[11px]">${details.cause}</p>
                    </div>
                    <div>
                        <span class="font-bold text-gray-900 block mb-1 flex items-center gap-1.5">
                            <i class="fa-regular fa-file-lines text-emerald-700"></i>
                            <span>Symptom Description:</span>
                        </span>
                        <p class="text-gray-600 leading-relaxed">${details.description}</p>
                    </div>
                    <div>
                        <span class="font-bold text-gray-900 block mb-1 flex items-center gap-1.5">
                            <i class="fa-solid fa-prescription-bottle-medical text-emerald-700"></i>
                            <span>Recommended Treatment & Cultural Controls:</span>
                        </span>
                        <ul class="space-y-1.5 pl-1">
                            ${details.treatment.map(item => `
                                <li class="flex items-start gap-2 text-gray-600">
                                    <i class="fa-solid fa-check text-emerald-600 mt-0.5 text-[10px] shrink-0"></i>
                                    <span>${item}</span>
                                </li>
                            `).join('')}
                        </ul>
                    </div>
                `;
                container.appendChild(infoCard);
            }
        }

        function lookupDiseaseDetails(className) {
            if (!diseaseKnowledgebase || diseaseKnowledgebase.length === 0)
                return null;
            const normalize = (str) =>
                (str || "")
                    .toLowerCase()
                    .replace(/tomatoe/g, "tomato")
                    .replace(/potatoe/g, "potato")
                    .replace(/[^a-z0-9]/g, "");
            const target = normalize(className);
            return (
                diseaseKnowledgebase.find((d) => {
                    const normId = normalize(d.id);
                    return normId === target;
                }) || null
            );
        }

        function showLoading(state) {
            const spinner = document.getElementById("loading-spinner");
            if (state) {
                spinner.classList.remove("hidden");
            } else {
                spinner.classList.add("hidden");
            }
        }

        function showToast(message) {
            logMessage("info", "UI", `Toast alert: "${message}"`);
            const toast = document.createElement("div");
            toast.className = "fixed bottom-4 right-4 bg-gray-900 text-white text-xs px-4 py-2.5 rounded-xl shadow-lg transition-opacity duration-300 opacity-0 z-50";
            toast.textContent = message;
            document.body.appendChild(toast);

            setTimeout(() => toast.classList.remove("opacity-0"), 10);
            setTimeout(() => {
                toast.classList.add("opacity-0");
                setTimeout(() => toast.remove(), 300);
            }, 3000);
        }

        window.addEventListener('DOMContentLoaded', async () => {
            logMessage("info", "App", "Plant Doctor application initialized.");
            await loadDiseaseKnowledgebase();
        });