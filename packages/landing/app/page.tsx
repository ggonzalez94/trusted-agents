import { Hero } from "@/components/sections/hero";
import { Problem } from "@/components/sections/problem";
import { HowItWorks } from "@/components/sections/how-it-works";
import { UseCases } from "@/components/sections/use-cases";
import { TrustModel } from "@/components/sections/trust-model";
import { TechStack } from "@/components/sections/tech-stack";
import { GetStarted } from "@/components/sections/get-started";
import { Footer } from "@/components/sections/footer";

export default function Page() {
	return (
		<main>
			<Hero />
			<Problem />
			<HowItWorks />
			<UseCases />
			<TrustModel />
			<TechStack />
			<GetStarted />
			<Footer />
		</main>
	);
}
